import { isIP } from 'net'
import { lookup } from 'dns/promises'

// ── Outbound-request SSRF guard (security.md F4 / F10) ──────────────────────
//
// A captured page controls its own og:image / cover URL, and the
// personallibrary:// protocol lets an arbitrary website choose a capture
// target. Both are fetched by the main process, so both can be aimed at
// internal infrastructure (cloud metadata, LAN devices, localhost services).
//
// Two levels of guard:
//   - assertHttpUrl        — scheme allow-list only (F10). Used at the
//     capture-target chokepoint, where the URL is user-chosen (localhost/LAN
//     capture stays allowed) so only the scheme is constrained.
//   - assertPublicHttpUrl  — scheme + DNS-resolve-all + private-range block
//     (F4). Used where the URL is page/website-controlled (cover download,
//     protocol-triggered capture), plus safeFetch, which re-validates on every
//     redirect hop.
//
// Dependency-free by design (node:net + node:dns only), matching the rest of
// the security module. Known residual: a resolve→connect TOCTOU DNS-rebind
// window remains (fetch re-resolves at connect time); closing it fully needs a
// custom undici dispatcher that pins the validated IP — deferred (LOW impact).

const MAX_REDIRECTS = 5

/** Throw unless `url` is a well-formed http(s) URL. */
export function assertHttpUrl(url: string): void {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`Unsupported URL scheme "${scheme}" — only http/https are allowed.`)
  }
}

/** Parse "a.b.c.d" into four octets, or null if not a dotted-quad IPv4. */
function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null
  return octets as [number, number, number, number]
}

function isPrivateIpv4(ip: string): boolean {
  const o = parseIpv4(ip)
  if (!o) return false
  const [a, b] = o
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 192 && b === 0 && o[2] === 0) return true // 192.0.0.0/24 IETF
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved + broadcast
  return false
}

/**
 * Expand an IPv6 string to its eight 16-bit hextets, or null if unparseable.
 * Handles `::` zero-compression and a trailing embedded dotted-quad IPv4
 * (`::ffff:127.0.0.1`). Numeric expansion is the ONLY reliable classifier here:
 * `new URL().hostname` re-serializes IPv4-mapped literals to their hex tail
 * (`::ffff:127.0.0.1` → `::ffff:7f00:1`), so any string/regex match on the
 * dotted form silently misses the exact inputs the SSRF guard must catch.
 */
function expandIpv6(addr: string): number[] | null {
  const halves = addr.split('::')
  if (halves.length > 2) return null // at most one '::'

  const toHextets = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (g.includes('.')) {
        // Embedded dotted IPv4 is only valid as the final group.
        if (i !== groups.length - 1) return null
        const v4 = parseIpv4(g)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null
        out.push(parseInt(g, 16))
      }
    }
    return out
  }

  const left = toHextets(halves[0])
  if (!left) return null
  if (halves.length === 1) return left.length === 8 ? left : null

  const right = toHextets(halves[1])
  if (!right) return null
  const zeros = 8 - left.length - right.length
  if (zeros < 1) return null // '::' must stand for at least one zero group
  return [...left, ...Array(zeros).fill(0), ...right]
}

/**
 * True if `ip` is loopback / private / link-local / ULA / multicast (or an
 * IPv4-mapped/compatible IPv6 address of such). Non-IP input returns false —
 * callers resolve hostnames to addresses before calling this.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPrivateIpv4(ip)
  if (family !== 6) return false

  const h = expandIpv6(ip.toLowerCase())
  if (!h) return false

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): first five
  // hextets zero and the sixth is 0x0000 or 0xffff. Classify by the embedded
  // IPv4 regardless of dotted-vs-hex encoding. `::` and `::1` land here too
  // (embedded 0.0.0.0 / 0.0.0.1 → 0.0.0.0/8, blocked).
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    if (h[5] === 0 || h[5] === 0xffff) {
      const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`
      return isPrivateIpv4(v4)
    }
  }

  // Native IPv6 ranges by numeric prefix (more robust than string startsWith,
  // which missed fe81::–febf:: link-local and mis-scoped ULA).
  const first = h[0]
  if (first >= 0xfe80 && first <= 0xfebf) return true // fe80::/10 link-local
  if (first >= 0xfc00 && first <= 0xfdff) return true // fc00::/7 unique-local
  if (first >= 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * Full SSRF guard: assert http(s) scheme, resolve the host, and reject if the
 * host is an IP literal in a blocked range OR resolves to any blocked address.
 */
export async function assertPublicHttpUrl(url: string): Promise<void> {
  assertHttpUrl(url)
  // URL wraps IPv6 literals in brackets — strip them for classification.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`Refusing to fetch a private/internal address: ${host}`)
    }
    return
  }

  const addrs = await lookup(host, { all: true })
  if (addrs.length === 0) {
    throw new Error(`Could not resolve host: ${host}`)
  }
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new Error(`Host ${host} resolves to a private/internal address: ${address}`)
    }
  }
}

/**
 * SSRF-safe fetch: validates the host on the initial URL and re-validates on
 * every redirect hop (manual redirect following, capped depth). Returns the
 * final non-redirect Response.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects: number = MAX_REDIRECTS,
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpUrl(current)
    const res = await fetch(current, { ...init, redirect: 'manual' })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res // redirect with no target — hand back as-is
      current = new URL(location, current).href // resolve relative redirects, then re-validate
      continue
    }
    return res
  }
  throw new Error(`Too many redirects (>${maxRedirects}) fetching ${url}`)
}
