import type { LlmClient, ChatMessage } from './ollamaClient'
import type { ScoredCandidate } from '../rerank'

// The hallucination-safe LLM book reranker (§ "LLM in the recommender"). It never
// GENERATES candidates: it is handed a shortlist of already-fetched, already-scored
// BOOK candidates, assigns each a throwaway local id (`b0`…), asks the model to score
// fit 0–1, and returns a sourceId→fit map after STRICT validation — unknown ids
// dropped, non-numeric fits dropped, out-of-range clamped. Any model / parse failure
// yields an EMPTY map, and applyLlmBookRerank then leaves the cosine order untouched,
// so the feature only ever refines, never breaks, recommendations.
//
// Books-only: fics are never passed to the model, and applyLlmBookRerank rewrites the
// score of `source === 'book'` candidates only — the fic bucket keeps pure cosine+MMR.

export const LLM = {
  SHORTLIST: 30, // top book candidates (by cosine) sent to the model
  BLEND_W: 0.5, // weight on the LLM fit vs. cosine in the blended score
  DESC_CHARS: 240, // per-candidate description truncation in the prompt
} as const

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Build the numbered candidate block — one line per shortlisted book. */
function candidateLines(books: ScoredCandidate[]): string {
  return books
    .map((s, i) => {
      const c = s.cand
      const parts = [`id: b${i}`, `title: ${c.title}`, `author: ${c.author ?? 'Unknown'}`]
      const subj = c.subjects.slice(0, 6).join(', ')
      if (subj) parts.push(`subjects: ${subj}`)
      const desc = (c.description ?? '').replace(/\s+/g, ' ').trim().slice(0, LLM.DESC_CHARS)
      if (desc) parts.push(`description: ${desc}`)
      return parts.join(' | ')
    })
    .join('\n')
}

function buildMessages(books: ScoredCandidate[], digest: string): ChatMessage[] {
  const system =
    "You are a book recommendation reranker. Given a reader's taste and a list of " +
    'candidate books, score each candidate from 0.0 to 1.0 for how well it fits the ' +
    "reader. Reward books that match the reader's themes, tone, and subjects — " +
    'including books by authors the reader has NOT read. Do not invent books; only ' +
    'score the candidates given. Respond with ONLY JSON of the form ' +
    '{"rankings":[{"id":"b0","fit":0.0}]}, one entry per candidate id you were given.'
  const user = `Reader taste (strongest first):\n${digest}\n\nCandidates:\n${candidateLines(books)}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

interface Ranking {
  id: string
  fit: number
}

/** Parse + validate the model reply into localId→fit, keeping only ids we sent. */
function parseRankings(raw: unknown, validIds: Set<string>): Map<string, number> {
  const out = new Map<string, number>()
  const rankings = (raw as { rankings?: unknown } | null)?.rankings
  if (!Array.isArray(rankings)) return out
  for (const r of rankings as Ranking[]) {
    if (!r || typeof r.id !== 'string' || !validIds.has(r.id) || out.has(r.id)) continue
    if (typeof r.fit !== 'number' || !Number.isFinite(r.fit)) continue
    out.set(r.id, clamp01(r.fit)) // first occurrence per id wins
  }
  return out
}

/**
 * Ask the model to score the shortlisted books' fit. Returns sourceId→fit for the
 * entries it validly scored (EMPTY on any failure — the caller falls back to cosine).
 * `books` should already be cosine-descending; the top LLM.SHORTLIST are sent.
 * Impure only via the injected `client`; the rest is pure and ABI-agnostic.
 */
export async function llmRerankBooks(
  books: ScoredCandidate[],
  digest: string,
  client: LlmClient,
  cfg = LLM,
): Promise<Map<string, number>> {
  if (books.length === 0 || digest.trim() === '') return new Map()
  const shortlist = books.slice(0, cfg.SHORTLIST)
  const raw = await client.chatJson(buildMessages(shortlist, digest))
  if (raw === null) return new Map()

  const validIds = new Set(shortlist.map((_, i) => `b${i}`))
  const byLocalId = parseRankings(raw, validIds)

  const bySourceId = new Map<string, number>()
  shortlist.forEach((s, i) => {
    const fit = byLocalId.get(`b${i}`)
    if (fit !== undefined) bySourceId.set(s.cand.sourceId, fit)
  })
  return bySourceId
}

/**
 * Blend the LLM fit map into book scores. Within the book bucket we map fit∈[0,1]
 * onto the bucket's own cosine range [min,max] and blend it with the actual cosine:
 *
 *   score := (1−W)·cosine + W·(min + fit·span)
 *
 * This is an order-preserving affine rescale of the plain `(1−W)·cosineNorm + W·fit`
 * blend (identical book ORDERING), chosen so the blended score stays on the cosine
 * scale — keeping books comparable to fics and to un-scored books in the cross-bucket
 * top-up and the final sort. Books absent from the fit map and ALL fics keep their
 * original score. Empty map ⇒ input returned unchanged. Returns a new array (no
 * mutation). Pure.
 */
export function applyLlmBookRerank(
  scored: ScoredCandidate[],
  fitBySourceId: Map<string, number>,
  cfg = LLM,
): ScoredCandidate[] {
  if (fitBySourceId.size === 0) return scored
  const books = scored.filter((s) => s.cand.source === 'book')
  if (books.length === 0) return scored

  let min = Infinity
  let max = -Infinity
  for (const s of books) {
    if (s.score < min) min = s.score
    if (s.score > max) max = s.score
  }
  const span = max - min

  return scored.map((s) => {
    if (s.cand.source !== 'book') return s
    const fit = fitBySourceId.get(s.cand.sourceId)
    if (fit === undefined) return s
    // Degenerate bucket (all book cosines equal): order by fit alone, kept near the
    // shared cosine magnitude so it doesn't jump scale.
    if (span <= 0) {
      return { ...s, score: (1 - cfg.BLEND_W) * s.score + cfg.BLEND_W * fit }
    }
    const fitScaled = min + fit * span
    return { ...s, score: (1 - cfg.BLEND_W) * s.score + cfg.BLEND_W * fitScaled }
  })
}
