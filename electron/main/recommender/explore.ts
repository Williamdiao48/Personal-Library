import { cosine } from './vectorMath'
import { looksLikeFiction } from './candidates'
import type { ScoredCandidate } from './rerank'

// ── Exploration (explore/exploit) — epsilon slots + a UCB-lite picker ───────────
//
// The recommender is otherwise pure exploit: it ranks candidates by cosine-to-taste
// (blended with the engagement centroid, ADR-0011) and diversifies the visible list
// with MMR — correct for relevance, but over time the taste centroid tightens and the
// feed converges on a shrinking neighbourhood (the bubble becomes a rut). Exploration
// deliberately reserves a few output slots for candidates the exploit ranker passed
// over, chosen "novel but not junk", so the feed keeps offering new directions — using
// ONLY this reader's own data (no cross-user learning; product frame locked 2026-08-25).
//
// WHERE this injects: `recommend()`'s selection/emit stage ONLY, downstream of all
// scoring. The taste/engagement math is untouched. See the scope + mechanism-survey
// docs and the Decision Record for why epsilon slots (with an explicit origin tag) beat
// the diffuse novelty-in-score / UCB-in-score alternatives: the origin tag makes the
// online A/B (explore-origin vs exploit-origin open-rate, via #3's open-log) clean.
//
// NOT OFFLINE-VALIDATABLE — by construction. Leave-one-out MRR rewards ranking held-out
// OWNED items high, and owned items are tautologically inside the taste neighbourhood, so
// any explore slot can only LOWER offline MRR (the same RERANK.LAMBDA category error;
// eval-benchmark-log.md F-5). So SLOTS/ρ are set by JUDGMENT, conservatively, flagged
// not-offline-tuned, and validated RETROSPECTIVELY via #3's open-log — never by the eval.
//
// CANNOT-HURT: `SLOTS = 0`, an empty tail, or an empty owned-evidence set ⇒ no picks ⇒
// the emitted feed is byte-identical to pure exploit.

/** Exploration tuning. All JUDGMENT-set, not offline-tuned (see the header). */
export interface ExploreConfig {
  /** Explore slots reserved per emitted page. `0` ⇒ exploration off. */
  SLOTS: number
  /**
   * Cosine floor below which an owned item is treated as noise, not regional evidence
   * (see `regionalEvidence`). NOT a hard neighbour wall — items above it accumulate
   * softly, so franchise *abundance* just under any single-item threshold still counts.
   */
  EVIDENCE_FLOOR: number
  /**
   * Absolute backstop on taste-cosine: no candidate below this is ever eligible, however
   * thin the tail. Guards against a whole-page washout where even the "best near-miss"
   * is itself weak (so the RELATIVE floor alone would still admit garbage).
   */
  MIN_EXPLORE_SCORE: number
  /**
   * The load-bearing relevance gate. Eligibility requires `score ≥ REL_FLOOR × (best
   * near-miss score in the tail)` — self-calibrating to the reader's own taste
   * distribution rather than a fixed cosine guess. A candidate a fraction as on-taste as
   * the reader's genuine near-misses (e.g. a bearing-engineering book against a
   * fiction-heavy taste) is cut before the objective runs. THIS is what makes exploration
   * "follow the user's general tastes" — the fix for pure-novelty frontier-chasing.
   */
  REL_FLOOR: number
  /**
   * Variability oversample. The picker ranks the eligible pool by objective, then SAMPLES
   * `SLOTS` from the top `SLOTS × OVERSAMPLE` (all high quality) via the injected RNG, so
   * consecutive refreshes vary among near-equal picks instead of being frozen. `1` ⇒
   * deterministic strict-top-SLOTS.
   */
  OVERSAMPLE: number
  /**
   * Redundancy wall against the VISIBLE exploit picks. An explore candidate whose cosine to
   * any just-emitted exploit card exceeds this is dropped as "more of what you're already
   * seeing" — the fix for explore cards that just replicate the normal picks. A genuinely
   * new direction (sci-fi against a fantasy feed) sits well below this and survives.
   */
  MAX_EXPLOIT_SIM: number
  /**
   * Minimum KNOWN page count for an explore pick. Unlike the exploit path (which admits
   * books with no page metadata), explore requires a known substantive length: the reader
   * owns nothing that's a 32-page picture book, and the token embedding can't tell a bear
   * ADVENTURE from a cute bear picture-book, so novelty alone would keep promoting the
   * latter. A candidate with no page count is ineligible for an explore slot. Judgment-set.
   */
  MIN_EXPLORE_PAGES: number
}

export const EXPLORE: ExploreConfig = {
  /**
   * Explore slots reserved per emitted page (a page = one `recommend()` call = 36 cards,
   * `DISCOVER_POOL`). 3/36 ≈ 8%: a real, measurable fraction while staying conservative —
   * these are *unvalidated* picks, so we spend few real slots until #3's open-log shows
   * explore cards actually get opened, then widen. `0` ⇒ exploration off (byte-identical).
   */
  SLOTS: 3,
  /**
   * Cosine floor for the soft evidence kernel (`regionalEvidence`). An owned item more
   * similar than this contributes `(cos − floor)²` to the region's evidence; below it,
   * nothing (pure noise). Deliberately LOW (0.2, not the old 0.5 hard wall) so the *many*
   * owned items sitting just below a hard threshold still accumulate — a franchise you
   * over-own (15 HP novels at cos ~0.45) makes its companion pockets read as
   * well-observed, even though no single novel crosses a hard wall. That is what "count
   * the abundance" means geometrically. Judgment-set.
   */
  EVIDENCE_FLOOR: 0.2,
  /**
   * Absolute taste-cosine backstop (see the interface). Kept modest — the RELATIVE floor
   * does the real per-reader calibration; this only catches whole-page washouts.
   */
  MIN_EXPLORE_SCORE: 0.25,
  /**
   * Eligibility requires `score ≥ 0.5 × best-near-miss score` (see the interface). Half
   * as on-taste as the reader's strongest passed-over candidate is the "recognizably
   * related" line — novel is welcome, irrelevant is not.
   */
  REL_FLOOR: 0.5,
  /** Sample 3 slots from the top 6 by objective (see the interface). */
  OVERSAMPLE: 2,
  /**
   * Drop an explore candidate within 0.7 cosine of any visible exploit card (see the
   * interface). A genuinely new genre lands well under this; a near-clone of a shown card
   * does not. Judgment-set — raise toward 1 to let explore echo the feed more, lower to
   * force a bigger jump. Tune post real-usage.
   */
  MAX_EXPLOIT_SIM: 0.7,
  /**
   * An explore pick must have a known length ≥ this (see the interface). 65 mirrors the
   * global substantive-length floor; the added strictness here is requiring the count to be
   * KNOWN, which is what excludes the no-page-count picture books. Judgment-set.
   */
  MIN_EXPLORE_PAGES: 65,
}

/**
 * UCB1-flavoured uncertainty for a region carrying `evidence` owned mass: `1/sqrt(1+e)`.
 * Monotonically decreasing in evidence — a region you've seen a lot stops looking
 * uncertain, a region you've barely touched stays high. Pure.
 */
export function uncertainty(evidence: number): number {
  return 1 / Math.sqrt(1 + evidence)
}

/**
 * Soft, abundance-sensitive evidence that `vec`'s region is already well-observed: sum a
 * similarity kernel `(cos − floor)²` over ALL owned vectors (contributions below `floor`
 * dropped as noise). This REPLACES a hard neighbour count at a single cosine wall — the
 * wall discarded the fact that a franchise the reader over-owns (many novels sitting just
 * below it) *is* strong evidence. Squaring down-weights the long tail of weak similarities
 * so a large library of loosely-related items can't inflate the sum; abundance in the
 * meaningful mid-band (0.4–0.5) still accumulates. Targets *ignorance*, not raw distance:
 * a far-but-already-owned region reads as high-evidence and is skipped. Pure.
 */
export function regionalEvidence(
  vec: Float32Array,
  ownedVecs: Float32Array[],
  floor: number,
): number {
  let e = 0
  for (const o of ownedVecs) {
    const s = cosine(vec, o) - floor
    if (s > 0) e += s * s
  }
  return e
}

/**
 * The explore objective: `taste_score × uncertainty(regionalEvidence)`. NOT pure novelty.
 * Pure `uncertainty` chases the *frontier* — it maximises distance from everything owned,
 * so it surfaces the genuinely irrelevant (a bearing-engineering book against a fiction
 * taste is maximally "novel" precisely because nothing owned is near it). Multiplying by
 * the taste score tethers exploration to the reader's general taste: a candidate must be
 * BOTH recognisably on-taste AND under-observed to score high. The objective peaks on the
 * sweet spot — a plausibly-liked book in a corner the reader owns little of — and collapses
 * for both irrelevant-but-novel (low score) and on-taste-but-already-saturated (low
 * uncertainty, which is exploit's job anyway). Pure.
 */
export function exploreObjective(score: number, evidence: number): number {
  return score * uncertainty(evidence)
}

/** Sample `n` distinct items from `arr` via `rng` (partial Fisher–Yates). `rng() === 0`
 * for every draw ⇒ the original order's first `n` (deterministic strict-top for tests). */
function sample<T>(arr: T[], n: number, rng: () => number): T[] {
  const a = arr.slice()
  const k = Math.min(n, a.length)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, k)
}

/**
 * Pick up to `cfg.SLOTS` exploration candidates from the passed-over `tail` (the
 * candidates the exploit path didn't select — already fetched, embedded, and scored, so
 * this is free of new work). "Novel but not junk", and above all STILL ON-TASTE:
 *
 *  1. Books only (fanfiction is already search-friendly — see below).
 *  2. Known substantive length: a book with no page count, or shorter than
 *     `MIN_EXPLORE_PAGES`, is ineligible. The reader owns nothing that's a picture book and
 *     the token embedding can't tell a bear ADVENTURE from a cute bear picture-book, so
 *     novelty alone would keep surfacing the latter — this structural floor cuts it.
 *  3. Relevance gate: `score ≥ max(MIN_EXPLORE_SCORE, REL_FLOOR × best-near-miss score)`.
 *     The relative term self-calibrates to the reader's own taste distribution, so a
 *     candidate a fraction as on-taste as their genuine near-misses is cut outright —
 *     this is what stops pure-novelty frontier-chasing from surfacing irrelevant junk.
 *  4. Redundancy wall: drop anything within `MAX_EXPLOIT_SIM` cosine of a VISIBLE exploit
 *     card, so explore opens a NEW direction instead of echoing the normal picks.
 *  5. Rank the survivors by `exploreObjective` (on-taste × under-observed), so among
 *     recognisably-relevant books we prefer the ones in corners the reader owns little of.
 *  6. SAMPLE `SLOTS` from the top `SLOTS × OVERSAMPLE` (all high-objective) via `rng`, so
 *     consecutive refreshes vary instead of returning a frozen list.
 *
 * BOOKS ONLY: explore draws exclusively from `source === 'book'` candidates. Fanfiction
 * is already highly search-friendly (tag/fandom browsing makes new fics trivial to find),
 * so the exploration budget is better spent surfacing unfamiliar *books* — the harder
 * discovery problem. Fics still flow through the normal exploit path untouched.
 *
 * Returns fewer than `SLOTS` when the eligible pool is thin — that's intended (a weak
 * page shouldn't manufacture bad picks). Returns `[]` (a strict no-op) when `SLOTS <= 0`,
 * the tail is empty, or there is NO owned evidence — the cannot-hurt invariant. Pure /
 * ABI-agnostic: unit-testable with synthetic vectors, no db (`rng` defaults to Math.random;
 * inject a deterministic one in tests).
 */
export function pickExplorePicks(
  tail: ScoredCandidate[],
  ownedVecs: Float32Array[],
  cfg: ExploreConfig = EXPLORE,
  rng: () => number = Math.random,
  exploitVecs: Float32Array[] = [],
): ScoredCandidate[] {
  // Cannot-hurt guards: no slots, nothing to draw from, or no evidence base to judge
  // "under-observed" against (an empty owned set would make everything maximally
  // uncertain and turn exploration into blind far-picking — refuse instead).
  if (cfg.SLOTS <= 0 || tail.length === 0 || ownedVecs.length === 0) return []

  // Books only; with a KNOWN substantive length (the no-page-count picture books novelty
  // keeps resurfacing); and that positively LOOK LIKE FICTION. The last is a positive gate,
  // not another blocklist: the nonfiction blocklists can't catch nonfiction on an arbitrary
  // novel topic (a seed-science textbook, a film art-book), and novelty rewards exactly that,
  // so explore requires a fiction marker instead. All cut structurally before the objective.
  const books = tail.filter(
    (c) =>
      c.cand.source === 'book' &&
      (c.cand.pages ?? 0) >= cfg.MIN_EXPLORE_PAGES &&
      looksLikeFiction(c.cand.title, c.cand.subjects),
  )
  if (books.length === 0) return []

  // Self-calibrating relevance floor: half as on-taste as the best passed-over book,
  // never below the absolute backstop (guards a whole-page washout where even the best
  // near-miss is weak).
  const bestScore = books.reduce((m, c) => Math.max(m, c.score), 0)
  const floor = Math.max(cfg.MIN_EXPLORE_SCORE, cfg.REL_FLOOR * bestScore)

  // Redundancy wall: a candidate too close to any VISIBLE exploit card is "more of the same"
  // — reject so explore opens a new direction rather than echoing the normal picks. No-op
  // when no exploit vecs are passed (keeps the picker usable/ testable standalone).
  const redundant = (v: Float32Array): boolean =>
    exploitVecs.some((e) => cosine(v, e) > cfg.MAX_EXPLOIT_SIM)

  const eligible = books
    .filter((c) => c.score >= floor && !redundant(c.vec))
    .map((c) => ({
      c,
      obj: exploreObjective(c.score, regionalEvidence(c.vec, ownedVecs, cfg.EVIDENCE_FLOOR)),
    }))
    // Highest objective first (on-taste × under-observed); ties → higher raw taste score.
    .sort((a, b) => b.obj - a.obj || b.c.score - a.c.score)

  // Sample from the top band so refreshes vary without dipping into lower-quality picks.
  const pool = eligible.slice(0, cfg.SLOTS * cfg.OVERSAMPLE)
  return sample(pool, cfg.SLOTS, rng).map((e) => e.c)
}
