import { all } from '../db'
import type { Embedder } from './embedder-core'
import { itemMetadataText } from './embeddingText'
import { cosine } from './vectorMath'
import { buildTaste, type TasteResult } from './taste'
import { buildTasteSeeds } from './tasteSeeds'
import { candidateKey, CANDIDATE_TEXT_VERSION, type Candidate, type SourceName } from './candidates'
import { unionCandidates, type CandidateSource } from './candidateSource'
import { loadCandidateVectors, saveCandidateVectors } from './candidateEmbeddings'
import { openLibrarySource } from './sources/openLibrary'
import { ao3Source } from './sources/ao3'
import { ffnSource } from './sources/ffn'
import { now, logTiming, timed } from './timing'
import type { Recommendation } from '../../../src/types'

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
  TOP_K: 12, // default cards recommend() emits (a Discover "page" widens this)
} as const

// candidateKey moved to candidates.ts (shared dedup identity); re-exported so
// existing importers (tests, cross-source union) keep a single call site.
export { candidateKey }

/** The production candidate sources, fanfic-first so a fic wins a title|author tie. */
export function defaultSources(): CandidateSource[] {
  return [ao3Source, ffnSource, openLibrarySource]
}

/**
 * A finished recommendation, ranked to taste. The shape lives in `src/types`
 * (`Recommendation`) so the renderer and the IPC boundary share one definition;
 * re-exported here under the historical name for existing call sites.
 */
export type RecommendationCard = Recommendation

const OPENLIBRARY_ORIGIN = 'https://openlibrary.org'

/**
 * Resolve a candidate to an openable http(s) URL. AO3/FFN fics already carry the
 * work URL as `sourceId`; OpenLibrary books carry a work KEY (`/works/OL…W`) that
 * must be prefixed with the origin. Pure.
 */
export function candidateUrl(cand: Candidate): string {
  const id = cand.sourceId
  if (/^https?:\/\//i.test(id)) return id
  if (cand.source === 'book') return `${OPENLIBRARY_ORIGIN}${id.startsWith('/') ? '' : '/'}${id}`
  return id
}

/**
 * The deterministic "why": the candidate's own subjects that overlap the reader's
 * taste-seed terms (case-insensitive), order-preserving on `subjects` and capped.
 * Empty when there's no overlap (e.g. an FFN→AO3 vocab gap) — the UI then falls
 * back to the candidate's own top subjects. Pure.
 */
export function matchedTags(subjects: string[], seedTerms: Set<string>, cap = 6): string[] {
  const out: string[] = []
  for (const s of subjects) {
    if (seedTerms.has(s.toLowerCase())) {
      out.push(s)
      if (out.length >= cap) break
    }
  }
  return out
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
  // maxSim[i] = similarity of remaining[i] to its NEAREST already-selected pick (0
  // until something is selected; redundancy only penalizes when positive). Kept in
  // step with `remaining` and updated only against the just-picked vector each
  // round, so the diversity penalty costs O(k·N) cosines instead of recomputing
  // every remaining×selected pair each round (O(k²·N)). Selection is identical —
  // the running max over selected equals the from-scratch max.
  const maxSim = new Array<number>(remaining.length).fill(0)
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0
    let bestMmr = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const mmr = lambda * remaining[i].score - (1 - lambda) * maxSim[i]
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }
    const pick = remaining.splice(bestIdx, 1)[0]
    maxSim.splice(bestIdx, 1)
    selected.push(pick)
    for (let i = 0; i < remaining.length; i++) {
      const sim = cosine(remaining[i].vec, pick.vec)
      if (sim > maxSim[i]) maxSim[i] = sim
    }
  }
  return selected
}

// ── source-balanced selection ─────────────────────────────────────────────────
// Pure embedding similarity ignores WHICH source a pick came from, so a library
// with a strong fandom signal (e.g. lots of Harry Potter fics) lets fics occupy
// the top score band and crowd books out — even when the library is mostly books.
// We instead split the picks into a "book" and a "fic" bucket and fill each to a
// quota proportional to the reader's own library composition, running MMR within
// each bucket. So the recommendation mix mirrors what they actually read.

/** Coarse bucket a candidate/library item falls in: published book vs fanfiction. */
export type SourceBucket = 'book' | 'fic'

/** ao3 + ffn are both fanfiction; everything else (books, imports) is `book`. */
export function bucketOf(source: SourceName): SourceBucket {
  return source === 'book' ? 'book' : 'fic'
}

/** Normalized author identity (lowercase, punctuation-stripped) for diversity dedup
 *  and owned-author matching; '' for a null/blank author. Pure. */
export function authorKey(author: string | null): string {
  return (author ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const BOOK_DIVERSITY = {
  // ≤ this share of book slots may go to authors the reader already owns, so the feed
  // skews to discovery (the "favor new authors" choice). The rest are authors new to
  // the reader. A per-author cap of 1 keeps any single author to one card.
  OWNED_AUTHOR_FRACTION: 0.2,
} as const

/**
 * Author-diverse book selection (§ "favor new authors"): at most ONE book per author,
 * and books by authors the reader already owns are capped to
 * `round(quota × OWNED_AUTHOR_FRACTION)` so discovery leads. New-author books fill
 * first (MMR within), then the small owned-author allowance; if either side
 * underfills, the remainder tops up from whatever's left so the feed never shrinks.
 * Pure — the caller sorts the merged picks.
 */
export function diversifyBookPicks(
  bookScored: ScoredCandidate[],
  ownedAuthors: Set<string>,
  quota: number,
  lambda: number,
  cfg = BOOK_DIVERSITY,
): ScoredCandidate[] {
  if (quota <= 0) return []

  // 1. ≤1 per author: keep the highest-scoring candidate for each normalized author.
  const byAuthor = new Map<string, ScoredCandidate>()
  for (const s of [...bookScored].sort((a, b) => b.score - a.score)) {
    const key = authorKey(s.cand.author)
    if (!byAuthor.has(key)) byAuthor.set(key, s)
  }
  const deduped = [...byAuthor.values()]

  // 2. Prefer authors new to the reader; cap owned-author books to the fraction.
  const owned = deduped.filter((s) => ownedAuthors.has(authorKey(s.cand.author)))
  const fresh = deduped.filter((s) => !ownedAuthors.has(authorKey(s.cand.author)))
  const ownedTarget = Math.min(owned.length, Math.round(quota * cfg.OWNED_AUTHOR_FRACTION))
  const freshTarget = quota - ownedTarget

  const picks = [...mmrSelect(fresh, freshTarget, lambda), ...mmrSelect(owned, ownedTarget, lambda)]

  // 3. Never shrink: top up from the leftovers (new-author side short, or owned past
  //    its cap) until we hit the quota or run out.
  if (picks.length < quota) {
    const taken = new Set(picks.map((s) => s.cand.sourceId))
    const rest = deduped.filter((s) => !taken.has(s.cand.sourceId))
    picks.push(...mmrSelect(rest, quota - picks.length, lambda))
  }
  return picks
}

/**
 * Split `k` slots between book and fic in proportion to the library mix, rounding
 * the book share and giving fic the remainder. All-of-one-kind → all slots there.
 * Pure.
 */
export function allocateSlots(
  k: number,
  mix: { book: number; fic: number },
): { book: number; fic: number } {
  const total = mix.book + mix.fic
  if (total === 0) return { book: k, fic: 0 }
  const book = Math.round((mix.book / total) * k)
  return { book, fic: k - book }
}

/**
 * Minimum candidates of EACH bucket the emitted pool should hold so the Discover
 * content-type filter (All/Books/Fanfiction) always has at least a page of the
 * minority type to show. ≥ the renderer's PAGE_SIZE (12).
 */
export const DISCOVER_BUCKET_FLOOR = 12

/**
 * Nudge a proportional `allocateSlots` result so each bucket reaches `floor`,
 * capped by how many candidates that bucket actually has (`avail`), taking the
 * difference from the other bucket's surplus (never dropping the other below its
 * own floor). Keeps `book + fic` constant. A TARGET, not a hard cap — selectByQuota
 * still tops up an underfilled bucket — so the proportional feed is unchanged
 * whenever both buckets already clear the floor. Pure.
 */
export function floorAlloc(
  alloc: { book: number; fic: number },
  floor: number,
  avail: { book: number; fic: number },
): { book: number; fic: number } {
  let { book, fic } = alloc
  const bookFloor = Math.min(floor, avail.book)
  const ficFloor = Math.min(floor, avail.fic)
  if (book < bookFloor) {
    const take = Math.min(bookFloor - book, Math.max(0, fic - ficFloor))
    book += take
    fic -= take
  }
  if (fic < ficFloor) {
    const take = Math.min(ficFloor - fic, Math.max(0, book - bookFloor))
    fic += take
    book -= take
  }
  return { book, fic }
}

/**
 * Select up to `k` picks honoring the per-bucket quota: MMR within each bucket for
 * its allotment, then—if a bucket underfills its quota—top the result up to `k`
 * from the best remaining candidates of either bucket (so the mix is a target, not
 * a hard cap that could shrink the feed). Final order is score-descending. Pure.
 */
export function selectByQuota(
  scored: ScoredCandidate[],
  k: number,
  alloc: { book: number; fic: number },
  lambda: number,
  ownedAuthors: Set<string> = new Set(),
): ScoredCandidate[] {
  const book = scored.filter((s) => bucketOf(s.cand.source) === 'book')
  const fic = scored.filter((s) => bucketOf(s.cand.source) === 'fic')
  // Books get author-diversity (≤1/author, favor new authors); fics keep plain MMR.
  const picked = [
    ...diversifyBookPicks(book, ownedAuthors, alloc.book, lambda),
    ...mmrSelect(fic, alloc.fic, lambda),
  ]

  if (picked.length < k) {
    const takenIds = new Set(picked.map((s) => s.cand.sourceId))
    const rest = scored.filter((s) => !takenIds.has(s.cand.sourceId))
    picked.push(...mmrSelect(rest, k - picked.length, lambda))
  }
  return picked.sort((a, b) => b.score - a.score)
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

const FANFIC_URL_RE = /archiveofourown\.org|fanfiction\.net/i

/** The library-derived rerank inputs, all from a SINGLE scan of `items`. */
interface LibrarySnapshot {
  /** Owned + dismissed exclusion sets (§9 step 2). */
  exclude: ExcludeSets
  /** Library composition — book vs fic — for proportional allocation. */
  mix: { book: number; fic: number }
  /** Normalized authors already in the library — book selection favors NEW authors. */
  ownedAuthors: Set<string>
}

/**
 * Read the active library once and derive BOTH the exclusion sets and the book/fic
 * mix from the same pass — they previously scanned `items` separately with the same
 * `deleted_at IS NULL` predicate. Dismissed recommendations add to the exclusions
 * from their own (small) table.
 */
function loadLibrarySnapshot(): LibrarySnapshot {
  const keys = new Set<string>()
  const ids = new Set<string>()
  const ownedAuthors = new Set<string>()
  let book = 0
  let fic = 0

  for (const r of all<{ title: string; author: string | null; source_url: string | null }>(
    `SELECT title, author, source_url FROM items WHERE deleted_at IS NULL`,
  )) {
    keys.add(candidateKey(r.title, r.author))
    const ak = authorKey(r.author)
    if (ak) ownedAuthors.add(ak)
    if (r.source_url) {
      ids.add(r.source_url)
      if (FANFIC_URL_RE.test(r.source_url)) fic++
      else book++
    } else {
      book++
    }
  }

  for (const r of all<{ id: string; title: string; author: string | null; source: string | null }>(
    `SELECT id, title, author, source FROM dismissed_recommendations`,
  )) {
    keys.add(candidateKey(r.title, r.author))
    ids.add(r.id)
    if (r.source) ids.add(r.source)
  }

  return { exclude: { keys, ids }, mix: { book, fic }, ownedAuthors }
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
 *
 * `taste` defaults to a fresh `buildTaste()` but can be passed in when the caller
 * already built it (the Discover IPC does, for its cold-start check) — building it
 * is a full library-signals scan + a decode of every stored embedding, so reusing
 * one avoids doing that twice per refresh.
 *
 * `opts.limit` widens the emitted pool beyond `TOP_K` (Discover asks for a page of
 * ~24); `opts.excludeIds` adds sourceIds to drop **before** scoring — Discover's
 * "load more" passes the cards already shown so a paged fetch returns the *next*
 * best candidates rather than repeating. Both default to the single-page behavior.
 *
 * `opts.fresh` marks a user-initiated Refresh: each source uses its shorter
 * SOFT_FLOOR_MS (instead of its hard cache TTL) as the staleness threshold, so an
 * aged candidate pool re-scrapes cheap→expensive as it ages. Omitted ⇒ serve cache.
 */
export async function recommend(
  embedder: Embedder,
  sources: CandidateSource[] = defaultSources(),
  taste: TasteResult = buildTaste(),
  opts: {
    limit?: number
    excludeIds?: readonly string[]
    fresh?: boolean
    // Restrict the whole run to one content type — used by Discover's Books/Fanfiction
    // filter so a filtered "load more" digs deeper into THAT type (fetching only its
    // sources and giving it every slot) instead of paging a mixed pool. Undefined =
    // the normal balanced/proportional run.
    contentMode?: 'books' | 'fanfiction'
    // 1-based page window forwarded to every source so a "load more" fetches the NEXT
    // window of results (deeper pages) rather than re-fetching page 1 and finding only
    // works already shown. Default (undefined ⇒ page 1) = today's single-page behavior.
    page?: number
  } = {},
): Promise<Recommendation[]> {
  const limit = opts.limit ?? RERANK.TOP_K
  const tTotal = now() // [discover-timing] whole-pipeline wall clock
  if (taste.centroids.length === 0) return [] // cold start — no taste, no recs (§8)

  // The reader's taste terms (lowercased union of every seed category) — the set a
  // candidate's own subjects are matched against for the deterministic "why" chips.
  const seeds = buildTasteSeeds(taste.liked)
  const seedTerms = new Set(
    [
      ...seeds.authors,
      ...seeds.fandoms,
      ...seeds.relationships,
      ...seeds.characters,
      ...seeds.freeforms,
      ...seeds.genres,
    ].map((t) => t.term.toLowerCase()),
  )

  // A content-mode run fetches ONLY that type's sources (book → OpenLibrary; fanfic →
  // AO3/FFN) — no point scraping fics we'll discard when the reader asked for books.
  const wantBucket: SourceBucket | null =
    opts.contentMode === 'books' ? 'book' : opts.contentMode === 'fanfiction' ? 'fic' : null
  const activeSources = wantBucket
    ? sources.filter((s) => bucketOf(s.name) === wantBucket)
    : sources

  // Fan out to the sources CONCURRENTLY. They hit independent hosts (AO3, FFN via
  // Cloudflare, OpenLibrary), so overlapping them costs no per-host etiquette and
  // collapses the wall time from the SUM of the three to the slowest one (usually
  // FFN's browser fetch). `allSettled` keeps the "one source down doesn't sink the
  // batch" guarantee, and results stay in `sources` order so the union's fanfic-first
  // tie-break is unchanged.
  // [discover-timing] each source is wrapped so we see AO3 vs FFN vs OpenLibrary wall
  // time individually — they run concurrently, so the fan-out total is the slowest one.
  const tFanout = now()
  const settled = await Promise.allSettled(
    activeSources.map((s) =>
      timed(`source:${s.name}`, () => s.fetch(taste.liked, { fresh: opts.fresh, page: opts.page })),
    ),
  )
  logTiming('fanout', tFanout, { page: opts.page ?? 1, mode: opts.contentMode ?? 'all' })
  const pools: Candidate[][] = settled.map((r) => (r.status === 'fulfilled' ? r.value : []))
  const fetched = unionCandidates(pools)
  if (fetched.length === 0) return [] // no tags/authors to search on, or all sources empty

  // One scan of the library → both the exclusion sets and the book/fic mix.
  const snapshot = loadLibrarySnapshot()
  // Discover "load more" excludes the cards already shown this session so the next
  // page digs deeper into the ranked pool instead of repeating (added to the sourceId
  // set filterCandidates drops against).
  if (opts.excludeIds) for (const id of opts.excludeIds) snapshot.exclude.ids.add(id)
  const kept = filterCandidates(fetched, snapshot.exclude)
  if (kept.length === 0) return []

  // Embed each kept candidate's Tier-A metadata text (D-C4-1) — now including a fic's
  // summary as a content signal — reusing vectors cached by sourceId from a prior
  // refresh so only candidates we haven't embedded before hit the model (the main
  // warm-path saving). The cache key folds in CANDIDATE_TEXT_VERSION so bumping the
  // embed-text recipe (e.g. adding the summary) invalidates stale thin vectors
  // instead of needing a shared-DB migration.
  const candCacheVersion = `${embedder.modelVersion}|${CANDIDATE_TEXT_VERSION}`
  const vecById = loadCandidateVectors(
    kept.map((c) => c.sourceId),
    candCacheVersion,
  )
  const misses = kept.filter((c) => !vecById.has(c.sourceId))
  if (misses.length > 0) {
    // [discover-timing] cold embedding = model load + N inferences; cached hits skip this.
    const tEmbed = now()
    const missVecs = await embedder.embed(
      misses.map((c) =>
        itemMetadataText(
          { title: c.title, author: c.author, description: c.description },
          c.subjects,
        ),
      ),
    )
    logTiming('embed', tEmbed, { misses: misses.length, cached: kept.length - misses.length })
    saveCandidateVectors(
      misses.map((c, i) => ({ sourceId: c.sourceId, vec: missVecs[i] })),
      candCacheVersion,
    )
    misses.forEach((c, i) => vecById.set(c.sourceId, missVecs[i]))
  }
  const scored: ScoredCandidate[] = kept.map((cand) => {
    const vec = vecById.get(cand.sourceId)!
    return { cand, vec, score: scoreCandidate(vec, taste.centroids) }
  })

  // Source-balanced selection: fill book/fic quotas proportional to the library
  // mix so the feed mirrors what the reader actually reads (not just whichever
  // source has the strongest embedding match). Then floor each bucket so the pool
  // carries at least a page of both types for Discover's content-type filter — the
  // floored minority lands in the score-ordered tail, leaving the visible top of an
  // unfiltered feed proportional as before.
  const avail = {
    book: scored.filter((s) => bucketOf(s.cand.source) === 'book').length,
    fic: scored.filter((s) => bucketOf(s.cand.source) === 'fic').length,
  }
  // A content-mode run gives every slot to the requested bucket (the other's sources
  // weren't even fetched); otherwise floor both buckets on the proportional split.
  const alloc = wantBucket
    ? { book: wantBucket === 'book' ? limit : 0, fic: wantBucket === 'fic' ? limit : 0 }
    : floorAlloc(allocateSlots(limit, snapshot.mix), DISCOVER_BUCKET_FLOOR, avail)
  const selected = selectByQuota(scored, limit, alloc, RERANK.LAMBDA, snapshot.ownedAuthors)
  const scoreById = new Map(selected.map((s) => [s.cand.sourceId, s.score]))
  const verified = verifyCandidates(
    selected.map((s) => s.cand),
    fetched,
  )

  logTiming('recommend:total', tTotal, {
    fetched: fetched.length,
    kept: kept.length,
    cards: verified.length,
  })
  return verified.map((c) => ({
    title: c.title,
    author: c.author,
    coverUrl: c.coverUrl,
    sourceId: c.sourceId,
    source: c.source,
    url: candidateUrl(c),
    subjects: c.subjects,
    matchedTags: matchedTags(c.subjects, seedTerms),
    score: scoreById.get(c.sourceId) ?? 0,
    description: c.description,
  }))
}
