// ── Outbound-request SSRF guard (security.md F4) — ROADMAP STUB ─────────────
//
// STATUS: not implemented. This is a reserved slot in the security module.
//
// Intent (see security.md F4 "SSRF via cover-image download and subresource
// fetch"): a captured page controls its own `og:image` / cover URL, which the
// main process then fetches (capture/index.ts downloadCover → fetch at ~L459).
// A malicious page can aim that at internal infrastructure:
//   http://169.254.169.254/…   (cloud metadata)
//   http://192.168.1.1/admin    (LAN device)
//   http://127.0.0.1:<port>/…   (localhost service)
//
// Intended surface:
//   export async function assertPublicHttpUrl(url: string): Promise<void>
//
// Behaviour when implemented:
//   - Allow only http:/https: schemes (reject file:, data:, etc.).
//   - Resolve the host and REJECT private / loopback / link-local ranges:
//       127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7.
//   - Re-validate the host after every redirect (defeat DNS-rebinding /
//     redirect-to-internal). Cap redirect depth.
//
// Call sites to wire once implemented: downloadCover() and the capture-target
// entry in capture/index.ts, plus the protocol-handler capture path.

export {}
