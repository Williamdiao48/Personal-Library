import { describe, it, expect, vi } from 'vitest'
import { handleDeleteAccount, type DeleteAccountDeps, type DeleteAccountReport } from './handler'

const UID = 'user-abc'
const OTHER = 'user-xyz'
const key = (uid: string, kind: 'content' | 'cover', n: number) =>
  `users/${uid}/${kind}/${'a'.repeat(63)}${n}`

// Baseline deps: JWT verifies to UID, R2 lists two objects, all deletes succeed, auth
// delete succeeds. `objects` + the fn overrides are per-test; every fn is a spy so tests
// can assert call args and ordering.
function makeDeps(
  over: Partial<DeleteAccountDeps> & { objects?: string[] } = {},
): DeleteAccountDeps {
  return {
    verifyJwt: over.verifyJwt ?? vi.fn(async () => UID),
    listObjects:
      over.listObjects ??
      vi.fn(async () => over.objects ?? [key(UID, 'content', 0), key(UID, 'cover', 1)]),
    deleteObject: over.deleteObject ?? vi.fn(async () => {}),
    deleteAuthUser: over.deleteAuthUser ?? vi.fn(async () => {}),
  }
}

function post(auth = 'Bearer good-jwt'): Request {
  return new Request('https://fn/delete-account', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
  })
}

describe('handleDeleteAccount', () => {
  it('answers a CORS preflight without touching anything', async () => {
    const deps = makeDeps()
    const res = await handleDeleteAccount(
      new Request('https://fn/delete-account', { method: 'OPTIONS' }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(deps.verifyJwt).not.toHaveBeenCalled()
    expect(deps.listObjects).not.toHaveBeenCalled()
    expect(deps.deleteAuthUser).not.toHaveBeenCalled()
  })

  it('rejects a non-POST method', async () => {
    const res = await handleDeleteAccount(
      new Request('https://fn/delete-account', { method: 'GET' }),
      makeDeps(),
    )
    expect(res.status).toBe(405)
  })

  it('returns 401 and deletes nothing when the JWT does not verify', async () => {
    const deps = makeDeps({ verifyJwt: vi.fn(async () => null) })
    const res = await handleDeleteAccount(post(), deps)
    expect(res.status).toBe(401)
    expect(deps.listObjects).not.toHaveBeenCalled()
    expect(deps.deleteObject).not.toHaveBeenCalled()
    expect(deps.deleteAuthUser).not.toHaveBeenCalled()
  })

  it('scopes the R2 purge strictly to the VERIFIED uid (never a caller-influenced prefix)', async () => {
    // Even though another uid exists in the world, the function only ever lists the
    // verified user's own prefix — identity comes from the token, not the request.
    const deps = makeDeps({ verifyJwt: vi.fn(async () => UID) })
    await handleDeleteAccount(post(), deps)
    expect(deps.listObjects).toHaveBeenCalledTimes(1)
    expect(deps.listObjects).toHaveBeenCalledWith(`users/${UID}/`)
    expect(deps.listObjects).not.toHaveBeenCalledWith(`users/${OTHER}/`)
  })

  it('purges every object under the prefix (no age-gate) then hard-deletes the auth user', async () => {
    const objects = [key(UID, 'content', 0), key(UID, 'cover', 1), key(UID, 'content', 2)]
    const deps = makeDeps({ objects })
    const res = await handleDeleteAccount(post(), deps)
    const body = (await res.json()) as DeleteAccountReport

    expect(res.status).toBe(200)
    expect(deps.deleteObject).toHaveBeenCalledTimes(3)
    for (const k of objects) expect(deps.deleteObject).toHaveBeenCalledWith(k)
    expect(deps.deleteAuthUser).toHaveBeenCalledTimes(1)
    expect(deps.deleteAuthUser).toHaveBeenCalledWith(UID)
    expect(body).toEqual({ ok: true, deletedObjects: 3, failedObjects: 0, authDeleted: true })
  })

  it('handles an empty prefix — no deletes, still removes the auth user', async () => {
    const deps = makeDeps({ objects: [] })
    const res = await handleDeleteAccount(post(), deps)
    const body = (await res.json()) as DeleteAccountReport
    expect(deps.deleteObject).not.toHaveBeenCalled()
    expect(deps.deleteAuthUser).toHaveBeenCalledWith(UID)
    expect(body).toEqual({ ok: true, deletedObjects: 0, failedObjects: 0, authDeleted: true })
  })

  it('is best-effort on R2 — a failing delete is counted but never blocks the auth delete', async () => {
    const objects = [key(UID, 'content', 0), key(UID, 'cover', 1)]
    const deleteObject = vi
      .fn<(key: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined) // first ok
      .mockRejectedValueOnce(new Error('R2 delete failed (500)')) // second throws
    const deps = makeDeps({ objects, deleteObject })
    const res = await handleDeleteAccount(post(), deps)
    const body = (await res.json()) as DeleteAccountReport

    expect(res.status).toBe(200)
    expect(deps.deleteAuthUser).toHaveBeenCalledWith(UID)
    expect(body).toEqual({ ok: true, deletedObjects: 1, failedObjects: 1, authDeleted: true })
  })

  it('purges R2 BEFORE deleting the auth user (ordering)', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      objects: [key(UID, 'content', 0)],
      deleteObject: vi.fn(async () => {
        calls.push('r2')
      }),
      deleteAuthUser: vi.fn(async () => {
        calls.push('auth')
      }),
    })
    await handleDeleteAccount(post(), deps)
    expect(calls).toEqual(['r2', 'auth'])
  })
})
