import { all } from '../db'
import type { Embedder } from './embedder-core'
import { itemMetadataText } from './embeddingText'
import { cosine } from './vectorMath'
import { buildTaste } from './taste'
import { candidateKey, type Candidate } from './candidates'
import { unionCandidates, type CandidateSource } from './candidateSource'
import { openLibrarySource } from './sources/openLibrary'
import { ao3Source } from './sources/ao3'
import { ffnSource } from './sources/ffn'

// C4.4 + F4 — the rerank (§9 steps 2–4): union the candidate sources (books + AO3
// fics), filter against what the user already owns/dismissed, embed each into the
// SAME content-only metadata space as library items (Tier-A `itemMetadataText`,
// D-C4-1 — NOT `embedItemVector`, which reads a content file candidates don't
// have), score by max-cosine-to-centroid, diversify with MMR (λ), verify, and emit
// ~10 cards. The scoring / MMR / filter / verify core is pure (ABI-agnostic); only
// `recommend()` touches the db, the sources (network) and the model (via the
// injected Embedder) → its test injects stub sources + a stub embedder.
//
// The orchestrator takes the raw `Embedder` (embed of text strings), not an
// `EmbedHost`: candidates have no content file, so we embed their metadata text
// directly (D-C4-1). `EmbedHost` stays the backfill seam. Sources are injected
// (defaulting to the production set) so the orchestration is tested without the
// network.

export const RERANK = {
  LAMBDA: 0.7, // MMR: relevance vs. diversity trade-off (§9, D6)
  TOP_K: 10, // how many cards recommend() emits
} as const

// candidateKey moved to candidates.ts (shared dedup identity); re-exported so
// existing importers (tests, cross-source union) keep a single call site.
export { candidateKey }

/** The production candidate sources, fanfic-first so a fic wins a title|author tie. */
export function defaultSources(): CandidateSource[] {
  return [ao3Source, ffnSource, openLibrarySource]
}

/** A finished recommendation: a real book the user doesn't own, ranked to taste. */
export interface RecommendationCard {
  title: string
  author: string | null
  coverUrl: string | null
  sourceId: string
  score: number
  /** LLM "why we picked this" blurb — unset in Chunk 4 (Chunk 5 / §11). */
  why?: string
}

/** A candidate paired with its embedding + taste score, carried through MMR. */
export interface ScoredCandidate {
  cand: Candidate
  vec: Float32Array
  score: number
}

/** The already-owned / dismissed exclusion sets `filterCandidates` drops against. */
export interface ExcludeSets {
  /** Normalized `title|author` keys of owned + dismissed books. */
  keys: Set<string>
  /** Source ids (OpenLibrary keys / source_urls) + ISBNs of owned + dismissed books. */
  ids: Set<string>
}

// ── pure core ─────────────────────────────────────────────────────────────────

/**
 * Drop candidates the user already owns or has dismissed: by normalized
 * `title|author` key, by sourceId, or by ISBN (D-C4-5). Pure.
 */
export function filterCandidates(cands: Candidate[], exclude: ExcludeSets): Candidate[] {
  return cands.filter((c) => {
    if (exclude.keys.has(candidateKey(c.title, c.author))) return false
    if (exclude.ids.has(c.sourceId)) return false
    if (c.isbn && exclude.ids.has(c.isbn)) return false
    return true
  })
}

/**
 * A candidate's taste score: the MAX cosine over the taste centroids (§7.4 / the
 * D5 k>1 seam). Empty centroids → −Infinity (unreachable — `recommend` refuses
 * before scoring — but keeps the value out of any max). Vectors are unit-length,
 * so cosine is a clean dot.
 */
export function scoreCandidate(vec: Float32Array, centroids: Float32Array[]): number {
  let best = -Infinity
  for (const c of centroids) {
    const s = cosine(vec, c)
    if (s > best) best = s
  }
  return best
}

/**
 * Maximal Marginal Relevance selection (§9, D6): greedily pick the candidate
 * maximizing `λ·score − (1−λ)·maxSim(to already-picked)`, so a cluster of
 * near-duplicate high scorers yields ONE pick and diversity is rewarded. Pure;
 * returns the selected `ScoredCandidate`s in pick order (score kept for the card).
 */
export function mmrSelect(scored: ScoredCandidate[], k: number, lambda: number): ScoredCandidate[] {
  const selected: ScoredCandidate[] = []
  const remaining = scored.slice()
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0
    let bestMmr = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i]
      let maxSim = 0 // similarity is only penalizing when positive (redundancy)
      for (const s of selected) {
        const sim = cosine(r.vec, s.vec)
        if (sim > maxSim) maxSim = sim
      }
      const mmr = lambda * r.score - (1 - lambda) * maxSim
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0])
  }
  return selected
}

/**
 * Guardrail (§9 step 4, D-C4-6): keep only picks that exist in the fetched set
 * (by normalized key). A no-op in Chunk 4 — picks are drawn from the fetched
 * candidates — but the seam Chunk 5's LLM `why`-step plugs into so a hallucinated
 * title can't reach a card. Pure.
 */
export function verifyCandidates(picked: Candidate[], fetched: Candidate[]): Candidate[] {
  const ok = new Set(fetched.map((c) => candidateKey(c.title, c.author)))
  return picked.filter((c) => ok.has(candidateKey(c.title, c.author)))
}

// ── db reads (orchestrator only) ──────────────────────────────────────────────

/** Build the owned + dismissed exclusion sets (§9 step 2). */
function loadExclusions(): ExcludeSets {
  const keys = new Set<string>()
  const ids = new Set<string>()

  for (const r of all<{ title: string; author: string | null; source_url: string | null }>(
    `SELECT title, author, source_url FROM items WHERE deleted_at IS NULL`,
  )) {
    keys.add(candidateKey(r.title, r.author))
    if (r.source_url) ids.add(r.source_url)
  }

  for (const r of all<{ title: string; author: string | null; id: string; source: string | null }>(
    `SELECT id, title, author, source FROM dismissed_recommendations`,
  )) {
    keys.add(candidateKey(r.title, r.author))
    ids.add(r.id)
    if (r.source) ids.add(r.source)
  }

  return { keys, ids }
}

// ── orchestrator ──────────────────────────────────────────────────────────────

/**
 * The pipeline (§9 + F4): taste → fan out to the candidate sources → union/dedup →
 * filter → embed → score → MMR → verify → ~10 cards. Refuses gracefully (returns
 * `[]`) when the library is too thin to have a taste centroid (cold start, D-C4-4)
 * — before hitting any source. Candidates embed via the raw `Embedder` on their
 * Tier-A metadata text (D-C4-1). `sources` is injected (defaulting to the
 * production set) so orchestration is tested without the network; a single source
 * throwing is skipped rather than sinking the batch. Touches the db + network +
 * model.
 */
export async function recommend(
  embedder: Embedder,
  sources: CandidateSource[] = defaultSources(),
): Promise<RecommendationCard[]> {
  const taste = buildTaste()
  if (taste.centroids.length === 0) return [] // cold start — no taste, no recs (§8)

  const pools: Candidate[][] = []
  for (const s of sources) {
    try {
      pools.push(await s.fetch(taste.liked))
    } catch {
      // One source down (network / parse) — skip it, keep the others.
    }
  }
  const fetched = unionCandidates(pools)
  if (fetched.length === 0) return [] // no tags/authors to search on, or all sources empty

  const kept = filterCandidates(fetched, loadExclusions())
  if (kept.length === 0) return []

  // One batched embed of every kept candidate's Tier-A metadata text (D-C4-1).
  const texts = kept.map((c) => itemMetadataText({ title: c.title, author: c.author }, c.subjects))
  const vecs = await embedder.embed(texts)
  const scored: ScoredCandidate[] = kept.map((cand, i) => ({
    cand,
    vec: vecs[i],
    score: scoreCandidate(vecs[i], taste.centroids),
  }))

  const selected = mmrSelect(scored, RERANK.TOP_K, RERANK.LAMBDA)
  const scoreById = new Map(selected.map((s) => [s.cand.sourceId, s.score]))
  const verified = verifyCandidates(
    selected.map((s) => s.cand),
    fetched,
  )

  return verified.map((c) => ({
    title: c.title,
    author: c.author,
    coverUrl: c.coverUrl,
    sourceId: c.sourceId,
    score: scoreById.get(c.sourceId) ?? 0,
  }))
}
