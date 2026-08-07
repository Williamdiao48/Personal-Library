import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock('../auth/client', () => ({ getSupabase: h.getSupabase }))

import { presignBlobUrl } from './presign'

beforeEach(() => {
  vi.clearAllMocks()
  h.getSupabase.mockReturnValue({ functions: { invoke: h.invoke } })
})

describe('presignBlobUrl', () => {
  it('invokes the blob-url function with { op, kind, hash } and returns the url', async () => {
    h.invoke.mockResolvedValue({ data: { url: 'https://r2/signed', key: 'k', expiresIn: 300 } })
    const url = await presignBlobUrl('get', 'content', 'abc123')
    expect(url).toBe('https://r2/signed')
    expect(h.invoke).toHaveBeenCalledWith('blob-url', {
      body: { op: 'get', kind: 'content', hash: 'abc123' },
    })
  })

  it('forwards the byte size for a put (the PUT cap) but omits it otherwise', async () => {
    h.invoke.mockResolvedValue({ data: { url: 'https://r2/signed', key: 'k', expiresIn: 300 } })
    await presignBlobUrl('put', 'content', 'abc123', 4096)
    expect(h.invoke).toHaveBeenCalledWith('blob-url', {
      body: { op: 'put', kind: 'content', hash: 'abc123', size: 4096 },
    })
  })

  it('throws when cloud is not configured (no client)', async () => {
    h.getSupabase.mockReturnValue(null)
    await expect(presignBlobUrl('get', 'cover', 'h')).rejects.toThrow(/not configured/)
  })

  it('throws when the function returns an error', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'unauthorized' } })
    await expect(presignBlobUrl('put', 'content', 'h')).rejects.toThrow(
      /presign failed: unauthorized/,
    )
  })

  it('throws when the function returns no url', async () => {
    h.invoke.mockResolvedValue({ data: {}, error: null })
    await expect(presignBlobUrl('put', 'content', 'h')).rejects.toThrow(/no url/)
  })
})
