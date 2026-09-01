import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub the SSRF-guarded fetch so tests never hit the network; each test drives
// its return value. Keep the real validation constants (caps drive the logic).
vi.mock('../security/net-guard', () => ({ safeFetch: vi.fn() }))

import { inlineBodyImages } from './inline-images'
import { safeFetch } from '../security/net-guard'
import { BODY_IMAGE_MAX_COUNT, COVER_MAX_BYTES } from '../security/validation'

const BASE = 'https://example.com/story/1'

/** Build a Response-like object for safeFetch to resolve with. */
function imgResponse(
  bytes: Buffer,
  contentType = 'image/png',
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Map<string, string>([
    ['content-type', contentType],
    ...Object.entries(extraHeaders),
  ])
  return {
    ok: true,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as Response
}

beforeEach(() => {
  vi.mocked(safeFetch).mockReset()
})

describe('inlineBodyImages', () => {
  it('returns image-free HTML byte-identical without touching the network', async () => {
    const html = '<p>Just prose, no pictures.</p><div class="chapter">More prose.</div>'
    const out = await inlineBodyImages(html, BASE)
    expect(out).toBe(html)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('leaves an existing data: image untouched and does not re-fetch it', async () => {
    const html = '<p><img src="data:image/png;base64,AAAA" alt="inline"></p>'
    const out = await inlineBodyImages(html, BASE)
    expect(out).toBe(html)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('rewrites a remote img to a data: URI', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(bytes, 'image/png'))

    const out = await inlineBodyImages('<p><img src="https://img.example/a.png" alt="x"></p>', BASE)

    expect(safeFetch).toHaveBeenCalledOnce()
    expect(out).toContain(`data:image/png;base64,${bytes.toString('base64')}`)
    expect(out).toContain('alt="x"')
    expect(out).not.toContain('https://img.example/a.png')
  })

  it('resolves a relative img src against the base URL before fetching', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(Buffer.from([1, 2, 3]), 'image/gif'))

    await inlineBodyImages('<img src="/pics/b.gif">', BASE)

    expect(safeFetch).toHaveBeenCalledWith('https://example.com/pics/b.gif', expect.anything())
  })

  it('drops the src (keeps alt) when the fetch fails', async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error('blocked host'))

    const out = await inlineBodyImages(
      '<p><img src="https://img.example/c.png" alt="fallback"></p>',
      BASE,
    )

    expect(out).not.toContain('src=')
    expect(out).toContain('alt="fallback"')
  })

  it('drops an SVG response (script vector) rather than inlining it', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(Buffer.from('<svg/>'), 'image/svg+xml'))

    const out = await inlineBodyImages('<img src="https://img.example/x.svg" alt="s">', BASE)

    expect(out).not.toContain('data:')
    expect(out).not.toContain('src=')
    expect(out).toContain('alt="s"')
  })

  it('drops an image whose declared content-length exceeds the per-image cap', async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      imgResponse(Buffer.from([1]), 'image/png', {
        'content-length': String(COVER_MAX_BYTES + 1),
      }),
    )

    const out = await inlineBodyImages('<img src="https://img.example/big.png">', BASE)

    expect(out).not.toContain('data:')
  })

  it('drops an image whose downloaded body exceeds the per-image cap', async () => {
    const oversized = Buffer.alloc(COVER_MAX_BYTES + 1, 1)
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(oversized, 'image/png'))

    const out = await inlineBodyImages('<img src="https://img.example/big.png">', BASE)

    expect(out).not.toContain('data:')
  })

  it('inlines only the first BODY_IMAGE_MAX_COUNT images, dropping the rest', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(Buffer.from([7]), 'image/png'))

    const imgs = Array.from(
      { length: BODY_IMAGE_MAX_COUNT + 3 },
      (_, i) => `<img src="https://img.example/${i}.png">`,
    ).join('')

    const out = await inlineBodyImages(imgs, BASE)

    // Only the first N eligible images are fetched at all.
    expect(safeFetch).toHaveBeenCalledTimes(BODY_IMAGE_MAX_COUNT)
    const inlined = out.match(/data:image\/png/g)?.length ?? 0
    expect(inlined).toBe(BODY_IMAGE_MAX_COUNT)
  })

  it('enforces the total-bytes cap across images', async () => {
    // Each image is the max per-image size (10 MiB); the 40 MiB total cap is the
    // binding limit, so only the first four fit and the rest are dropped.
    const big = Buffer.alloc(COVER_MAX_BYTES, 9) // 10 MiB each; total cap 40 MiB
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(big, 'image/png'))

    const imgs = Array.from(
      { length: 6 }, // 6 × 10 MiB = 60 MiB > 40 MiB total cap
      (_, i) => `<img src="https://img.example/${i}.png">`,
    ).join('')

    const out = await inlineBodyImages(imgs, BASE)

    // 40 MiB / 10 MiB = 4 images inlined; the remaining 2 dropped.
    const inlined = out.match(/data:image\/png/g)?.length ?? 0
    expect(inlined).toBe(4)
  })

  it('drops an image whose fetch never settles, without hanging capture', async () => {
    vi.useFakeTimers()
    try {
      // safeFetch never resolves (mimics a hung DNS lookup / dead host).
      vi.mocked(safeFetch).mockReturnValue(new Promise<Response>(() => {}))

      const pending = inlineBodyImages('<img src="https://img.example/hang.png" alt="h">', BASE)
      // Advance past the per-image timeout so withTimeout resolves null.
      await vi.advanceTimersByTimeAsync(7000)
      const out = await pending

      expect(out).not.toContain('data:')
      expect(out).not.toContain('src=')
      expect(out).toContain('alt="h"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports image count via onProgress', async () => {
    vi.mocked(safeFetch).mockResolvedValue(imgResponse(Buffer.from([1]), 'image/png'))
    const onProgress = vi.fn()

    await inlineBodyImages(
      '<img src="https://img.example/a.png"><img src="https://img.example/b.png">',
      BASE,
      onProgress,
    )

    expect(onProgress).toHaveBeenCalledWith('Downloading 2 images…')
  })
})
