// reconcile-blobs — server-side R2 orphan reconciliation backstop (H2b).
//
// The client reaper (electron/main/cloud/reaper.ts) can only delete blobs that some
// device's local `blob_sync` ledger still knows about. Two orphan classes escape it
// FOREVER: (1) a "lost uploader" whose DB died after upload — no device holds a ledger
// row for the hash, so nothing drives the DELETE once the item is purged everywhere;
// (2) pre-H2a Phase-4 scratch objects stranded under users/<uid>/content/<sha256(raw)>
// (never laddered into blob_sync). Postgres is the globally-authoritative "is this blob
// wanted?" oracle — every device pushes blob_hash / cover_hash / purged_at, LWW-merged —
// so a service_role sweep can reap what no single client can.
//
// This is the runtime-agnostic core. The Deno wiring (env, R2 AwsClient, the service_role
// Supabase client, the ListObjectsV2 XML parse) lives in index.ts and is injected via
// `deps`, so the vitest `server` project exercises this in Node against fakes — mirroring
// blob-url / process-extract.
//
// SAFETY. The server has no "I just uploaded this" knowledge, so a client PUT that lands in
// R2 seconds before its `items` row syncs would momentarily look orphaned. An AGE-GATE
// (only consider objects OLDER than minAgeMs — 30d by default) makes an in-flight/recent
// upload impossible to touch; a genuine orphan just lingers a few extra weeks before
// reclaim, which is fine for a rarely-run janitor. And deletion is OFF unless the request
// explicitly arms it with `{ "apply": true }` (dry-run default) — first runs only REPORT.

export interface R2Object {
  key: string
  /** Object LastModified, unix-ms. */
  lastModified: number
}

export interface ReconcileDeps {
  /** True iff the Authorization header carries the admin secret (constant-time compare). */
  verifyAdmin: (authHeader: string) => boolean
  /** List every object under `prefix` (the impl paginates ListObjectsV2 internally). */
  listObjects: (prefix: string) => Promise<R2Object[]>
  /** blob_hash ∪ cover_hash for the user's UN-PURGED items (service_role, RLS bypassed). */
  listWantedHashes: (userId: string) => Promise<Set<string>>
  /** Delete one R2 object. Idempotent (a 2xx/absent key is success). */
  deleteObject: (key: string) => Promise<void>
  now: () => number
  /** Objects younger than this (`now - lastModified`) are never candidates. */
  minAgeMs: number
  /** Force dry-run regardless of the request (env kill-switch); default false. A normal
   *  call still defaults to dry-run — deletion needs `{ "apply": true }` in the body. */
  dryRun: boolean
  /** Optional durable audit sink: persist this run's report (the `reconcile_runs`
   *  insert in index.ts). Best-effort — a throw here is swallowed so a missing table or
   *  a transient insert error can never fail the sweep itself. Omit to skip logging. */
  recordRun?: (report: ReconcileReport) => Promise<void>
}

export interface ReconcileReport {
  scanned: number
  keptWanted: number
  skippedRecent: number
  orphans: string[]
  deleted: string[]
  dryRun: boolean
  minAgeMs: number
}

// Only ever touch a key of this exact shape — a verified-uid-scoped, sha256-named
// permanent blob. Anything else (a malformed key, or the top-level `scratch/` prefix the
// H2a lifecycle rule owns) is ignored: this sweep never deletes outside users/{content,cover}.
const KEY_RE = /^users\/([^/]+)\/(content|cover)\/([0-9a-f]{64})$/

const DAY_MS = 86_400_000

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })

export async function handleReconcile(req: Request, deps: ReconcileDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // 1 — Admin gate. A shared secret, not a user JWT: there is no user context, and the
  //     function wields service_role. A wrong/absent secret never reaches R2 or Postgres.
  if (!deps.verifyAdmin(req.headers.get('Authorization') ?? '')) {
    return json({ error: 'unauthorized' }, 401)
  }

  // 2 — Body is OPTIONAL: a bare POST is a dry-run with the configured defaults.
  //     { apply?: true, minAgeDays?: number } — apply arms deletion; minAgeDays overrides
  //     the age-gate (e.g. for a first eyeball run at a tighter window).
  let body: { apply?: unknown; minAgeDays?: unknown } = {}
  try {
    const text = await req.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid json' }, 400)
  }

  // Dry-run unless the caller explicitly arms it; the env kill-switch (deps.dryRun) wins.
  const dryRun = deps.dryRun || body.apply !== true
  const minAgeMs =
    typeof body.minAgeDays === 'number' && Number.isFinite(body.minAgeDays) && body.minAgeDays >= 0
      ? body.minAgeDays * DAY_MS
      : deps.minAgeMs

  const objects = await deps.listObjects('users/')
  const now = deps.now()

  // One Postgres round-trip per uid, memoized — a bucket LIST returns keys grouped by owner.
  const wantedCache = new Map<string, Set<string>>()
  const wantedFor = async (uid: string): Promise<Set<string>> => {
    let w = wantedCache.get(uid)
    if (!w) {
      w = await deps.listWantedHashes(uid)
      wantedCache.set(uid, w)
    }
    return w
  }

  const report: ReconcileReport = {
    scanned: 0,
    keptWanted: 0,
    skippedRecent: 0,
    orphans: [],
    deleted: [],
    dryRun,
    minAgeMs,
  }

  for (const obj of objects) {
    const m = KEY_RE.exec(obj.key)
    if (!m) continue // defensive — never act on a key outside users/{content,cover}/<hash>
    report.scanned++
    const [, uid, , hash] = m

    // Wanted iff SOME un-purged item of this owner references the hash (blob_hash for a
    // content object, cover_hash for a cover — the same Set covers both). A merely-trashed
    // item (deleted_at set, purged_at NULL) still counts, so its bytes survive.
    const wanted = await wantedFor(uid)
    if (wanted.has(hash)) {
      report.keptWanted++
      continue
    }

    // Orphan candidate. Never touch a RECENT object — it may be an in-flight upload whose
    // items row hasn't synced yet (the server has no per-device upload knowledge).
    if (now - obj.lastModified < minAgeMs) {
      report.skippedRecent++
      continue
    }

    report.orphans.push(obj.key)
    if (!dryRun) {
      try {
        await deps.deleteObject(obj.key)
        report.deleted.push(obj.key)
      } catch {
        // Best-effort — a failed delete stays reported as an orphan (not deleted) and the
        // next sweep retries it. One bad key never aborts the whole reconciliation.
      }
    }
  }

  // Durable audit trail (scheduled monthly sweep + any manual run land here). Best-effort:
  // logging must never turn a completed reconciliation into a 500.
  if (deps.recordRun) {
    try {
      await deps.recordRun(report)
    } catch {
      // Swallow — a missing reconcile_runs table or a transient insert error just means
      // this run isn't logged; the reconciliation result is still returned to the caller.
    }
  }

  return json(report, 200)
}
