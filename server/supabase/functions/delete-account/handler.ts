// delete-account — permanently erase a signed-in user's cloud footprint (L2).
//
// A user cannot delete their own auth.users row (that needs service_role), so this
// server function does it on their behalf, authorized by the caller's OWN JWT. Two
// stores must be cleared:
//
//   1. R2 — the user's blob prefix (users/<uid>/content/* and .../cover/*). R2 has no
//      FK/RLS, so nothing cascades: we LIST the prefix and DELETE every object. Unlike
//      reconcile-blobs this is an UNCONDITIONAL purge — no age-gate, no wanted-hash diff;
//      the account is going away, so every object under the prefix goes.
//   2. Postgres — every synced table + profiles is `references auth.users(id) on delete
//      cascade`, so a single hard-delete of the auth user cascades the whole row footprint.
//      No per-table delete, no migration.
//
// This is the runtime-agnostic core. The Deno wiring (JWT verify via anon client, R2
// AwsClient, the service_role admin client) lives in index.ts and is injected via `deps`,
// so the vitest `server` project exercises this in Node against fakes — mirroring
// blob-url / process-extract / reconcile-blobs.
//
// AUTHORIZATION. The uid comes from the verified TOKEN, never the request body — the caller
// can only ever delete THEIR OWN account. A body-supplied uid is ignored entirely.
//
// ORDERING. Purge R2 FIRST, then delete the auth user. Identity is the thing that must go
// for a deletion to be honored, so the auth delete always runs even if some R2 deletes fail
// (best-effort per object). Any R2 leftover self-heals: once the user's items rows are
// cascaded away, reconcile-blobs' wanted-set for that uid is empty, so the monthly sweep
// reaps the remainder.

export interface DeleteAccountDeps {
  /** Verify the Authorization header; resolve the trusted user id or null. */
  verifyJwt: (authHeader: string) => Promise<string | null>
  /** List every object key under `prefix` (the impl paginates ListObjectsV2 internally). */
  listObjects: (prefix: string) => Promise<string[]>
  /** Delete one R2 object. Idempotent (a 2xx/absent key is success). */
  deleteObject: (key: string) => Promise<void>
  /** Hard-delete the auth user, cascading all Postgres rows (service_role). */
  deleteAuthUser: (userId: string) => Promise<void>
}

export interface DeleteAccountReport {
  ok: boolean
  /** R2 objects successfully deleted. */
  deletedObjects: number
  /** R2 objects whose delete threw (left for the reconcile-blobs backstop). */
  failedObjects: number
  /** True once the auth user (and its Postgres cascade) is gone. */
  authDeleted: boolean
}

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

export async function handleDeleteAccount(
  req: Request,
  deps: DeleteAccountDeps,
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // 1 — Verify the caller's Supabase JWT. The uid comes from the TOKEN, so a client can
  //     only ever delete its own account; the request body is never consulted for identity.
  const userId = await deps.verifyJwt(req.headers.get('Authorization') ?? '')
  if (!userId) return json({ error: 'unauthorized' }, 401)

  // 2 — Purge R2 first. Full-prefix, unconditional; best-effort per object so one bad key
  //     never blocks the auth delete (a failed delete is reported and the backstop retries).
  const keys = await deps.listObjects(`users/${userId}/`)
  let deletedObjects = 0
  let failedObjects = 0
  for (const key of keys) {
    try {
      await deps.deleteObject(key)
      deletedObjects++
    } catch {
      failedObjects++
    }
  }

  // 3 — Delete the auth user (hard). Cascades every synced table + profiles. Always runs,
  //     even if some R2 deletes failed — identity removal is what makes the deletion real.
  await deps.deleteAuthUser(userId)

  const report: DeleteAccountReport = {
    ok: true,
    deletedObjects,
    failedObjects,
    authDeleted: true,
  }
  return json(report, 200)
}
