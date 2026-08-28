import { describe, it, expect, vi } from 'vitest'
import { handleReconcile, type ReconcileDeps, type R2Object, type ReconcileReport } from './handler'

const H = (c: string) => c.repeat(64) // a 64-hex sha256 stand-in
const HASH_A = H('a')
const HASH_B = H('b')
const HASH_C = H('c')
const DAY = 86_400_000
const NOW = 1_800_000_000_000 // fixed clock

const SECRET = 'Bearer s3cr3t'
const key = (uid: string, kind: 'content' | 'cover', hash: string) => `users/${uid}/${kind}/${hash}`

// Baseline deps: admin ok, a fixed clock, a 30-day gate, dry-run NOT forced (so the
// request body decides). `objects` + `wanted` are per-test; deleteObject records calls.
function makeDeps(
  over: {
    objects?: R2Object[]
    wanted?: Record<string, string[]>
    dryRun?: boolean
    verifyAdmin?: ReconcileDeps['verifyAdmin']
  } = {},
): ReconcileDeps {
  const wanted = over.wanted ?? {}
  return {
    verifyAdmin: over.verifyAdmin ?? ((h) => h === SECRET),
    listObjects: vi.fn(async () => over.objects ?? []),
    listWantedHashes: vi.fn(async (uid: string) => new Set(wanted[uid] ?? [])),
    deleteObject: vi.fn(async () => {}),
    now: () => NOW,
    minAgeMs: 30 * DAY,
    dryRun: over.dryRun ?? false,
  }
}

function post(body?: unknown, auth = SECRET): Request {
  return new Request('https://fn/reconcile-blobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const old = { lastModified: NOW - 60 * DAY } // well past the 30-day gate
const fresh = { lastModified: NOW - 1 * DAY } // inside the gate

async function report(res: Response): Promise<ReconcileReport> {
  return (await res.json()) as ReconcileReport
}

describe('handleReconcile', () => {
  it('401s without the admin secret and never lists or deletes', async () => {
    const deps = makeDeps({ objects: [{ key: key('u1', 'content', HASH_A), ...old }] })
    const res = await handleReconcile(post({ apply: true }, 'Bearer wrong'), deps)
    expect(res.status).toBe(401)
    expect(deps.listObjects).not.toHaveBeenCalled()
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('401s when the Authorization header is absent', async () => {
    const deps = makeDeps()
    const res = await handleReconcile(post({ apply: true }, ''), deps)
    expect(res.status).toBe(401)
  })

  it('keeps content AND cover objects a live item still references', async () => {
    const deps = makeDeps({
      objects: [
        { key: key('u1', 'content', HASH_A), ...old },
        { key: key('u1', 'cover', HASH_B), ...old },
      ],
      wanted: { u1: [HASH_A, HASH_B] }, // blob_hash ∪ cover_hash
    })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.keptWanted).toBe(2)
    expect(r.orphans).toEqual([])
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('reports an old orphan but does NOT delete it on a dry-run (default, no apply)', async () => {
    const orphan = key('u1', 'content', HASH_C)
    const deps = makeDeps({ objects: [{ key: orphan, ...old }], wanted: { u1: [HASH_A] } })
    const r = await report(await handleReconcile(post(), deps)) // bare POST = dry-run
    expect(r.dryRun).toBe(true)
    expect(r.orphans).toEqual([orphan])
    expect(r.deleted).toEqual([])
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('deletes an old orphan when armed with apply:true', async () => {
    const orphan = key('u1', 'content', HASH_C)
    const deps = makeDeps({ objects: [{ key: orphan, ...old }], wanted: { u1: [HASH_A] } })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.dryRun).toBe(false)
    expect(r.deleted).toEqual([orphan])
    expect(deps.deleteObject).toHaveBeenCalledWith(orphan)
  })

  it('never deletes a RECENT orphan — the in-flight-upload guard (age-gate)', async () => {
    const recent = key('u1', 'content', HASH_C)
    const deps = makeDeps({ objects: [{ key: recent, ...fresh }], wanted: { u1: [] } })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.skippedRecent).toBe(1)
    expect(r.orphans).toEqual([])
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('reclaims a pre-H2a stranded scratch object (old content/<sha256raw>, no blob_hash match)', async () => {
    // Old clients uploaded raw extraction sources to users/<uid>/content/<sha256(raw)>,
    // whose hash never matches any blob_hash (= sha256 of the packed archive) → orphan.
    const strandedScratch = key('u1', 'content', HASH_B)
    const deps = makeDeps({ objects: [{ key: strandedScratch, ...old }], wanted: { u1: [HASH_A] } })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.deleted).toEqual([strandedScratch])
  })

  it("does not let user B's hash protect user A's object (per-owner scoping)", async () => {
    const aObj = key('uA', 'content', HASH_A)
    const deps = makeDeps({
      objects: [aObj].map((k) => ({ key: k, ...old })),
      wanted: { uA: [], uB: [HASH_A] }, // same hash wanted by B, but A owns this object
    })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.deleted).toEqual([aObj])
    expect(deps.listWantedHashes).toHaveBeenCalledWith('uA')
  })

  it('queries Postgres once per owner (memoized across that owner’s objects)', async () => {
    const deps = makeDeps({
      objects: [
        { key: key('u1', 'content', HASH_A), ...old },
        { key: key('u1', 'cover', HASH_B), ...old },
      ],
      wanted: { u1: [HASH_A, HASH_B] },
    })
    await handleReconcile(post({ apply: true }), deps)
    expect(deps.listWantedHashes).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed / non-users / unknown-kind keys — never scanned or deleted', async () => {
    const deps = makeDeps({
      objects: [
        { key: `scratch/u1/${HASH_A}`, ...old }, // owned by the H2a lifecycle rule
        { key: `users/u1/thumbnail/${HASH_A}`, ...old }, // unknown kind
        { key: `users/u1/content/not-a-hash`, ...old }, // bad hash
        { key: `random/key`, ...old },
      ],
      wanted: { u1: [] },
    })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.scanned).toBe(0)
    expect(r.orphans).toEqual([])
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('honors a minAgeDays body override (tightening the gate lets a newer orphan through)', async () => {
    const orphan = key('u1', 'content', HASH_C)
    // 5 days old: inside the default 30d gate, but past a 1-day override.
    const deps = makeDeps({
      objects: [{ key: orphan, lastModified: NOW - 5 * DAY }],
      wanted: { u1: [] },
    })
    const r = await report(await handleReconcile(post({ apply: true, minAgeDays: 1 }), deps))
    expect(r.minAgeMs).toBe(1 * DAY)
    expect(r.deleted).toEqual([orphan])
  })

  it('a delete failure leaves the key reported as an orphan (not deleted) and does not abort', async () => {
    const bad = key('u1', 'content', HASH_B)
    const good = key('u1', 'content', HASH_C)
    const deleteObject = vi.fn(async (k: string) => {
      if (k === bad) throw new Error('R2 hiccup')
    })
    const deps: ReconcileDeps = {
      ...makeDeps({
        objects: [
          { key: bad, ...old },
          { key: good, ...old },
        ],
        wanted: { u1: [] },
      }),
      deleteObject,
    }
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.orphans).toEqual([bad, good])
    expect(r.deleted).toEqual([good]) // bad failed → not counted deleted, sweep continued
  })

  it('the env kill-switch (deps.dryRun) forces dry-run even when apply:true is sent', async () => {
    const orphan = key('u1', 'content', HASH_C)
    const deps = makeDeps({ objects: [{ key: orphan, ...old }], wanted: { u1: [] }, dryRun: true })
    const r = await report(await handleReconcile(post({ apply: true }), deps))
    expect(r.dryRun).toBe(true)
    expect(r.deleted).toEqual([])
    expect(deps.deleteObject).not.toHaveBeenCalled()
  })

  it('405s a non-POST and answers an OPTIONS preflight', async () => {
    const deps = makeDeps()
    expect(
      (await handleReconcile(new Request('https://fn/x', { method: 'GET' }), deps)).status,
    ).toBe(405)
    const pre = await handleReconcile(new Request('https://fn/x', { method: 'OPTIONS' }), deps)
    expect(pre.status).toBe(200)
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('records the run via recordRun (durable audit sink) with the final report', async () => {
    const orphan = key('u1', 'content', HASH_C)
    const recordRun = vi.fn(async (_report: ReconcileReport) => {})
    const deps: ReconcileDeps = {
      ...makeDeps({ objects: [{ key: orphan, ...old }], wanted: { u1: [HASH_A] } }),
      recordRun,
    }
    await handleReconcile(post(), deps) // bare POST = dry-run
    expect(recordRun).toHaveBeenCalledTimes(1)
    const logged = recordRun.mock.calls[0][0]
    expect(logged.orphans).toEqual([orphan])
    expect(logged.dryRun).toBe(true)
    expect(logged.deleted).toEqual([])
  })

  it('a recordRun failure is swallowed — the sweep still returns its report (best-effort)', async () => {
    const orphan = key('u1', 'content', HASH_C)
    const recordRun = vi.fn(async () => {
      throw new Error('reconcile_runs table missing')
    })
    const deps: ReconcileDeps = {
      ...makeDeps({ objects: [{ key: orphan, ...old }], wanted: { u1: [] } }),
      recordRun,
    }
    const res = await handleReconcile(post({ apply: true }), deps)
    expect(res.status).toBe(200)
    const r = await report(res)
    expect(r.deleted).toEqual([orphan]) // sweep completed despite the audit-log throw
    expect(recordRun).toHaveBeenCalledTimes(1)
  })

  it('400s invalid JSON (but tolerates an empty body as a dry-run)', async () => {
    const deps = makeDeps()
    const badReq = new Request('https://fn/reconcile-blobs', {
      method: 'POST',
      headers: { Authorization: SECRET, 'content-type': 'application/json' },
      body: 'not json',
    })
    expect((await handleReconcile(badReq, deps)).status).toBe(400)

    // A bare POST with no body is valid — the defaults apply (dry-run).
    const empty = new Request('https://fn/reconcile-blobs', {
      method: 'POST',
      headers: { Authorization: SECRET },
    })
    expect((await handleReconcile(empty, deps)).status).toBe(200)
  })
})
