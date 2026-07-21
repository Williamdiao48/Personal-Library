import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// assertPublicHttpUrl resolves hostnames via dns/promises, and safeFetch drives
// the global fetch — mock both so the resolve-all + redirect-revalidation paths
// run deterministically without touching the network.
vi.mock('dns/promises', () => ({ lookup: vi.fn() }))

import { assertHttpUrl, isPrivateAddress, assertPublicHttpUrl, safeFetch } from './net-guard'
import { lookup } from 'dns/promises'

const mockLookup = vi.mocked(lookup)

describe('isPrivateAddress', () => {
  const PRIVATE = [
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata / link-local
    '100.64.0.1', // CGNAT
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ]
  const PUBLIC = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1', // just outside 172.16/12
    '172.15.255.255', // just below 172.16/12
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8', // IPv4-mapped public
  ]

  it.each(PRIVATE)('flags %s as private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })
  it.each(PUBLIC)('flags %s as public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
  it('returns false for non-IP input', () => {
    expect(isPrivateAddress('example.com')).toBe(false)
  })
})

describe('assertHttpUrl', () => {
  it('accepts http and https', () => {
    expect(() => assertHttpUrl('http://example.com/x')).not.toThrow()
    expect(() => assertHttpUrl('https://example.com/x')).not.toThrow()
  })
  it('rejects other schemes', () => {
    expect(() => assertHttpUrl('ftp://example.com')).toThrow(/scheme/)
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/scheme/)
    expect(() => assertHttpUrl('data:text/html,x')).toThrow(/scheme/)
  })
  it('rejects malformed URLs', () => {
    expect(() => assertHttpUrl('not a url')).toThrow(/Invalid URL/)
  })
})

describe('assertPublicHttpUrl (IP-literal hosts, no DNS)', () => {
  it('rejects private/loopback literal hosts', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/')).rejects.toThrow(/private/)
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow(/private/)
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private/,
    )
  })
  it('rejects non-http schemes before resolving', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/scheme/)
  })
  it('accepts a public IP literal', async () => {
    await expect(assertPublicHttpUrl('http://8.8.8.8/')).resolves.toBeUndefined()
  })
})

describe('assertPublicHttpUrl (hostname resolution)', () => {
  beforeEach(() => mockLookup.mockReset())

  it('resolves the host and passes when every address is public', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(assertPublicHttpUrl('https://example.com/story')).resolves.toBeUndefined()
    expect(mockLookup).toHaveBeenCalledWith('example.com', { all: true })
  })

  it('rejects when the host resolves to any private/internal address', async () => {
    // DNS-rebind style: a public-looking name that resolves to link-local metadata.
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])
    await expect(assertPublicHttpUrl('https://sneaky.example/')).rejects.toThrow(
      /resolves to a private\/internal address/,
    )
  })

  it('rejects when the host does not resolve at all', async () => {
    mockLookup.mockResolvedValue([])
    await expect(assertPublicHttpUrl('https://nx.example/')).rejects.toThrow(/Could not resolve/)
  })
})

describe('safeFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    mockLookup.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const resp = (status: number, location?: string): Response =>
    ({
      status,
      headers: { get: (h: string) => (h.toLowerCase() === 'location' ? (location ?? null) : null) },
    }) as unknown as Response

  it('returns the response directly for a non-redirect status', async () => {
    fetchMock.mockResolvedValue(resp(200))
    // Public IP literal host → no DNS, and the validation runs before fetch.
    const res = await safeFetch('http://93.184.216.34/')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('follows a redirect, re-validating and resolving a relative Location', async () => {
    fetchMock
      .mockResolvedValueOnce(resp(301, '/next')) // relative → resolved against the current URL
      .mockResolvedValueOnce(resp(200))
    const res = await safeFetch('http://93.184.216.34/start')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('http://93.184.216.34/next')
  })

  it('re-validates each hop and refuses a redirect that points to a private address', async () => {
    fetchMock.mockResolvedValueOnce(resp(302, 'http://169.254.169.254/latest/meta-data'))
    await expect(safeFetch('http://93.184.216.34/')).rejects.toThrow(/private/)
  })

  it('hands back a redirect response that carries no Location header', async () => {
    fetchMock.mockResolvedValueOnce(resp(302)) // no Location
    const res = await safeFetch('http://93.184.216.34/')
    expect(res.status).toBe(302)
  })

  it('throws once the redirect chain exceeds the hop cap', async () => {
    fetchMock.mockResolvedValue(resp(302, 'http://93.184.216.34/loop'))
    await expect(safeFetch('http://93.184.216.34/', {}, 1)).rejects.toThrow(/Too many redirects/)
  })
})
