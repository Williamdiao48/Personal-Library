import { createHash } from 'node:crypto'

// The R2 object address: a real sha256 of the blob bytes (packed content archive,
// or raw cover image). This is NOT items.content_hash — that column is a fast
// 32-bit TEXT fingerprint for refresh/embedding staleness (util/contentHash.ts),
// unsuitable as an object key. Identical bytes → identical hash → one R2 key →
// dedupe (Spike 1 proved the round-trip).
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
