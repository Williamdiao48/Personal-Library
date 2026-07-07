// Fast non-crypto content hash: combines the text length with a sample of the
// beginning + end (whole string under 4 KB). Good enough to detect a meaningful
// content change without crypto overhead. Single source of truth — shared by
// capture (items.content_hash), library refresh-detection, and the recommender's
// embedding staleness gate (embeddingContentHash).
export function computeContentHash(text: string): string {
  let h = 0
  const sample = text.length > 4000 ? text.slice(0, 2000) + text.slice(-2000) : text
  for (let i = 0; i < sample.length; i++) {
    h = (Math.imul(31, h) + sample.charCodeAt(i)) | 0
  }
  return `${text.length}:${h >>> 0}`
}
