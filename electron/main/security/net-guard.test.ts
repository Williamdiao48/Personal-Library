import { describe, it, expect } from 'vitest'
import { assertHttpUrl, isPrivateAddress, assertPublicHttpUrl } from './net-guard'

describe('isPrivateAddress', () => {
  const PRIVATE = [
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata / link-local
    '100.64.0.1',      // CGNAT
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',          // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ]
  const PUBLIC = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',       // just outside 172.16/12
    '172.15.255.255',   // just below 172.16/12
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',   // IPv4-mapped public
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
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private/)
  })
  it('rejects non-http schemes before resolving', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/scheme/)
  })
  it('accepts a public IP literal', async () => {
    await expect(assertPublicHttpUrl('http://8.8.8.8/')).resolves.toBeUndefined()
  })
})
