import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock('../auth/client', () => ({ getSupabase: h.getSupabase }))

import { deleteCloudAccount } from './deleteAccount'

beforeEach(() => {
  vi.clearAllMocks()
  h.getSupabase.mockReturnValue({ functions: { invoke: h.invoke } })
})

describe('deleteCloudAccount', () => {
  it('invokes the delete-account function and returns ok on success', async () => {
    h.invoke.mockResolvedValue({
      data: { ok: true, deletedObjects: 2, failedObjects: 0, authDeleted: true },
      error: null,
    })
    const res = await deleteCloudAccount()
    expect(res).toEqual({ ok: true })
    expect(h.invoke).toHaveBeenCalledWith('delete-account')
  })

  it('returns not-configured (no invoke) when there is no client', async () => {
    h.getSupabase.mockReturnValue(null)
    const res = await deleteCloudAccount()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not configured/)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('surfaces a function error without signalling success', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'unauthorized' } })
    const res = await deleteCloudAccount()
    expect(res).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('treats a non-ok response body as a failure (never signs out on a partial delete)', async () => {
    h.invoke.mockResolvedValue({ data: { ok: false }, error: null })
    const res = await deleteCloudAccount()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/did not complete/)
  })
})
