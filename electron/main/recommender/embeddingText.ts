import type { Embedder } from './embedder'
import { extractPlainText, hasUsableContent, type EmbeddableItem } from './contentText'

// C1.4 — the D8 core. Turns a library item into ONE vector via the two-tier
// representation: a Tier-A metadata/tags mini-embed blended with a Tier-B
// content fingerprint (sampled chunk-pool of the full text). All the arithmetic
// helpers are pure (unit-tested directly); embedItemVector orchestrates them
// with the C1.2 Embedder + C1.3 extractor.

/** ~400 words ≈ bge-small's ~512-token window (D8). */
export const WORDS_PER_CHUNK = 400
/** ~20 evenly-spread chunks pin a book's dominant-topic centroid cheaply (D8). */
export const SAMPLE_COUNT = 20
/** Default blend weights: metadata vs. content fingerprint (tunable by eval). */
export const W_META = 0.5
export const W_CONTENT = 0.5

/** Fields the Tier-A metadata text draws on (structurally satisfied by Item). */
export interface MetadataItem {
  title: string
  author?: string | null
  description?: string | null
  review?: string | null
}

/** Everything embedItemVector needs about an item. */
export type EmbedItemInput = EmbeddableItem & MetadataItem

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).trimEnd()
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

// ── Tier A: metadata text builder (single source of truth; see design §6) ─────

/**
 * The Tier-A metadata string: `title | author | tags | description | review`.
 * Optional fields are dropped when absent; description/review are weak signals
 * (D1) and truncated. Reused by lifecycle + fine-tune-data formatting so
 * train/serve match.
 */
export function itemMetadataText(item: MetadataItem, tags: string[]): string {
  const parts = [`title: ${item.title}`]
  if (item.author) parts.push(`author: ${item.author}`)
  if (tags.length) parts.push(`tags: ${tags.join(', ')}`)
  if (item.description) parts.push(`description: ${truncate(item.description, 400)}`)
  if (item.review) parts.push(`review: ${truncate(item.review, 400)}`)
  return parts.join(' | ')
}

// ── Tier B: chunk → sample → pool ─────────────────────────────────────────────

/** Split text into ~`wordsPerChunk`-word chunks (whitespace-tokenized). */
export function chunkText(text: string, wordsPerChunk = WORDS_PER_CHUNK): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
  }
  return chunks
}

/**
 * Pick `k` chunks spread evenly across the whole document (bin midpoints, so
 * ~5%, 15%, 25% … depth — not the first k). Returns all, in order, when there
 * are ≤ k chunks.
 */
export function sampleChunks(chunks: string[], k = SAMPLE_COUNT): string[] {
  const n = chunks.length
  if (n <= k) return chunks.slice()
  const out: string[] = []
  for (let j = 0; j < k; j++) {
    out.push(chunks[Math.floor(((j + 0.5) * n) / k)])
  }
  return out
}

/** Element-wise mean of vectors, then L2-normalize → the content fingerprint. */
export function poolVectors(vecs: Float32Array[]): Float32Array {
  const dim = vecs[0].length
  const acc = new Float32Array(dim)
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) acc[i] += v[i]
  }
  for (let i = 0; i < dim; i++) acc[i] /= vecs.length
  return l2normalize(acc)
}

/**
 * Blend the metadata embed with the (optional) content fingerprint:
 * `normalize(wMeta·eMeta + wContent·eContent)`. With no content fingerprint
 * (Tier-A only), return eMeta unchanged — it's already unit-length.
 */
export function blend(
  eMeta: Float32Array,
  eContent?: Float32Array | null,
  wMeta = W_META,
  wContent = W_CONTENT,
): Float32Array {
  if (!eContent) return eMeta
  const dim = eMeta.length
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = wMeta * eMeta[i] + wContent * eContent[i]
  return l2normalize(out)
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Build an item's final embedding: Tier-A metadata text + a Tier-B content
 * fingerprint (when there's usable content), embedded in ONE batched call and
 * blended. Degrades to Tier A alone when content is missing/too short.
 */
export async function embedItemVector(
  item: EmbedItemInput,
  tags: string[],
  embedder: Embedder,
): Promise<Float32Array> {
  const metaText = itemMetadataText(item, tags)
  const fullText = await extractPlainText(item)
  const sampled = hasUsableContent(fullText) ? sampleChunks(chunkText(fullText)) : []

  // Single batch: [metaText, ...sampledChunks] → vectors aligned to input order.
  const vectors = await embedder.embed([metaText, ...sampled])
  const eMeta = vectors[0]
  const eContent = sampled.length ? poolVectors(vectors.slice(1)) : null
  return blend(eMeta, eContent)
}
