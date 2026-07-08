import { all } from '../db'
import type { Embedder } from './embedder-core'
import { itemMetadataText } from './embeddingText'
import { cosine } from './vectorMath'
import { buildTaste, type LikedItem } from './taste'
import { buildSeedQueries, type SeedSource } from './seedQueries'
import { fetchCandidates, type Candidate } from './candidates'

// C4.4 — the rerank (§9 steps 2–4): filter candidates against what the user
// already owns/dismissed, embed each into the SAME content-only metadata space as
// library items (Tier-A `itemMetadataText`, D-C4-1 — NOT `embedItemVector`, which
// reads a content file candidates don't have), score by max-cosine-to-centroid,
// diversify with MMR (λ), verify, and emit ~10 cards. The scoring / MMR / filter /
// verify core is pure (ABI-agnostic); only `recommend()` touches the db, the
// network (via fetchCandidates) and the model (via the injected Embedder) → its
// test needs the Node ABI + a stub embedder + a mocked fetch.
//
// The orchestrator takes the raw `Embedder` (embed of text strings), not an
// `EmbedHost`: candidates have no content file, so we embed their metadata text
// directly (D-C4-1). `EmbedHost` stays the backfill seam.

export const RERANK = {
  LAMBDA: 0.7, // MMR: relevance vs. diversity trade-off (§9, D6)
  TOP_K: 10, // how many cards recommend() emits
  SEED_SOURCE_LIMIT: 100, // cap liked items fed to the seeder (keeps the IN() bounded)
} as const

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

/** Lowercase, strip punctuation, collapse whitespace — for tolerant title/author matching. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The normalized dedup identity for a book: `title|author`, lowercased with
 * punctuation stripped and whitespace collapsed (D-C4-5: exact-normalized, no
 * fuzzy match). Shared by the library/dismissed set builders and `filterCandidates`
 * so both sides normalize identically.
 */
export function candidateKey(title: string, author: string | null): string {
  return `${norm(title)}|${norm(author ?? '')}`
}

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

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * Join the taste engine's liked ids (weight-descending) to each item's author +
 * tags → the seed sources the query builder consumes. Capped at
 * SEED_SOURCE_LIMIT (the top-weight items dominate the seeds anyway, and it keeps
 * the IN() under SQLite's bound-parameter ceiling).
 */
function loadSeedSources(liked: LikedItem[]): SeedSource[] {
  const top = liked.slice(0, RERANK.SEED_SOURCE_LIMIT)
  if (top.length === 0) return []
  const ids = top.map((l) => l.id)

  const authorById = new Map<string, string | null>()
  for (const r of all<{ id: string; author: string | null }>(
    `SELECT id, author FROM items WHERE id IN (${placeholders(ids.length)})`,
    ids,
  )) {
    authorById.set(r.id, r.author)
  }

  const tagsById = new Map<string, string[]>()
  for (const r of all<{ item_id: string; name: string }>(
    `SELECT it.item_id AS item_id, t.name AS name
     FROM item_tags it JOIN tags t ON t.id = it.tag_id
     WHERE it.item_id IN (${placeholders(ids.length)})`,
    ids,
  )) {
    const list = tagsById.get(r.item_id)
    if (list) list.push(r.name)
    else tagsById.set(r.item_id, [r.name])
  }

  return top.map((l) => ({
    author: authorById.get(l.id) ?? null,
    tags: tagsById.get(l.id) ?? [],
    weight: l.weight,
  }))
}

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
 * The Chunk-4 pipeline (§9): taste → seed → fetch → filter → embed → score →
 * MMR → verify → ~10 cards. Refuses gracefully (returns `[]`) when the library is
 * too thin to have a taste centroid (cold start, D-C4-4) — before hitting
 * OpenLibrary. Candidates embed via the raw `Embedder` on their Tier-A metadata
 * text (D-C4-1). Touches the db + network + model.
 */
export async function recommend(embedder: Embedder): Promise<RecommendationCard[]> {
  const taste = buildTaste()
  if (taste.centroids.length === 0) return [] // cold start — no taste, no recs (§8)

  const sources = loadSeedSources(taste.liked)
  const queries = buildSeedQueries(sources)
  if (queries.length === 0) return [] // no tags/authors to search on

  const fetched = await fetchCandidates(queries)
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
