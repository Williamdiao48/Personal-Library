import { all } from '../db'
import type { LikedItem } from './taste'

// F4 — the categorized seed model every candidate source builds its queries from.
// Where the OpenLibrary path seeds from the user's flat manual tags, the fanfic
// sources need the *native* tag categories (F1/F2): AO3/FFN search is tag-native,
// so a fandom-anchored query is far stronger than a bag of words. buildTasteSeeds
// joins the liked items to `item_source_tags` (+ their authors) and sums affinity
// per category. Reads the DB; the per-source query builders that consume it are
// pure.

const SEED_SOURCE_LIMIT = 100 // cap liked items fed in (keeps the IN() bounded)

export interface WeightedTerm {
  term: string
  weight: number
}

/** Liked-affinity-weighted native terms, bucketed by tag category, heaviest-first. */
export interface TasteSeeds {
  authors: WeightedTerm[]
  fandoms: WeightedTerm[]
  relationships: WeightedTerm[]
  characters: WeightedTerm[]
  freeforms: WeightedTerm[]
  genres: WeightedTerm[]
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

/**
 * Sum weights per term (case-insensitively) and return heaviest-first with an
 * alphabetical tie-break. The kept casing is the lexicographically-first variant —
 * chosen deterministically rather than by SQLite's unspecified row order, so cache
 * keys / eyeball runs are stable.
 */
function aggregate(entries: { term: string; weight: number }[]): WeightedTerm[] {
  const map = new Map<string, WeightedTerm>()
  for (const { term, weight } of entries) {
    const display = term.replace(/\s+/g, ' ').trim()
    if (!display) continue
    const key = display.toLowerCase()
    const cur = map.get(key)
    if (cur) {
      cur.weight += weight
      if (display < cur.term) cur.term = display // deterministic casing, order-independent
    } else {
      map.set(key, { term: display, weight })
    }
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
}

export function buildTasteSeeds(liked: LikedItem[]): TasteSeeds {
  const empty: TasteSeeds = {
    authors: [],
    fandoms: [],
    relationships: [],
    characters: [],
    freeforms: [],
    genres: [],
  }
  const top = liked.filter((l) => l.weight > 0).slice(0, SEED_SOURCE_LIMIT)
  if (top.length === 0) return empty
  const ids = top.map((l) => l.id)
  const weightById = new Map(top.map((l) => [l.id, l.weight]))
  const ph = placeholders(ids.length)

  const authorEntries: { term: string; weight: number }[] = []
  for (const r of all<{ id: string; author: string | null }>(
    `SELECT id, author FROM items WHERE id IN (${ph})`,
    ids,
  )) {
    if (r.author) authorEntries.push({ term: r.author, weight: weightById.get(r.id) ?? 0 })
  }

  const byCategory: Record<string, { term: string; weight: number }[]> = {
    fandom: [],
    relationship: [],
    character: [],
    freeform: [],
    genre: [],
  }
  for (const r of all<{ item_id: string; name: string; category: string }>(
    `SELECT item_id, name, category FROM item_source_tags WHERE item_id IN (${ph})`,
    ids,
  )) {
    const bucket = byCategory[r.category]
    if (bucket) bucket.push({ term: r.name, weight: weightById.get(r.item_id) ?? 0 })
  }

  return {
    authors: aggregate(authorEntries),
    fandoms: aggregate(byCategory.fandom),
    relationships: aggregate(byCategory.relationship),
    characters: aggregate(byCategory.character),
    freeforms: aggregate(byCategory.freeform),
    genres: aggregate(byCategory.genre),
  }
}

// ── AO3-specific seeds (named-field queries) ──────────────────────────────────
// AO3's works-search named tag fields (relationship_names/character_names/
// fandom_names) are EXACT canonical-tag matches — feeding an FFN-abbreviated name
// ("Harry P./Fleur D.") into them returns ~0 (verified live). So the AO3 source
// must anchor only on tags that came from AO3 items (canonical vocabulary); FFN's
// abbreviated names are kept out of the named fields (they'd re-create the
// query-poisoning zero-out). Origin is decided by the owning item's source_url.

/** AO3-canonical seed terms (post-resolution), one list per named field to fill. */
export interface Ao3TagSeeds {
  /** Canonical relationships → `work_search[relationship_names]` (top priority). */
  relationships: WeightedTerm[]
  /** Canonical characters → `work_search[character_names]`. */
  characters: WeightedTerm[]
  /** Canonical fandoms → `work_search[fandom_names]` (exact canonical). */
  fandoms: WeightedTerm[]
  /** Fandoms with no canonical form — safe only in the fuzzy free-text `query` fallback. */
  fandomsFreeText: WeightedTerm[]
}

/**
 * A category's terms split by whether they're already AO3-canonical (lifted from an
 * AO3 capture, exact-match-ready) or raw (from FFN etc., abbreviated → need
 * autocomplete resolution before they can fill an exact named field).
 */
export interface RawSplit {
  canonical: WeightedTerm[]
  raw: WeightedTerm[]
}

/** Pre-resolution AO3 seeds: each named-field category split canonical-vs-raw. */
export interface Ao3RawSeeds {
  relationships: RawSplit
  characters: RawSplit
  fandoms: RawSplit
  /**
   * Characters restricted to liked fics tagged as *romance* — the only ones a
   * co-listed-character pairing should be inferred from. Two characters sharing an
   * adventure/gen fic are just two characters; in a romance fic they're a ship signal.
   */
  romanceCharacters: RawSplit
}

const AO3_HOST_LIKE = '%archiveofourown.org%'
// A fic counts as romance when it carries a Romance genre (FFN) or freeform (AO3) tag.
const ROMANCE_TAG = 'romance'

/**
 * Build AO3 seeds from the liked items, splitting each named-field category by tag
 * origin: names lifted from AO3 items are already canonical (`canonical`); names
 * from non-AO3 items (FFN's abbreviations) are `raw` and must be run through the
 * autocomplete resolver before they can fill an exact named field. Reads the db;
 * the resolver + query builder that consume it live elsewhere.
 */
export function buildAo3RawSeeds(liked: LikedItem[]): Ao3RawSeeds {
  const empty: Ao3RawSeeds = {
    relationships: { canonical: [], raw: [] },
    characters: { canonical: [], raw: [] },
    fandoms: { canonical: [], raw: [] },
    romanceCharacters: { canonical: [], raw: [] },
  }
  const top = liked.filter((l) => l.weight > 0).slice(0, SEED_SOURCE_LIMIT)
  if (top.length === 0) return empty
  const ids = top.map((l) => l.id)
  const weightById = new Map(top.map((l) => [l.id, l.weight]))
  const ph = placeholders(ids.length)

  // The subset of liked items that are romance fics — the only ones whose co-listed
  // characters may seed an inferred pairing.
  const romanceIds = new Set(
    all<{ item_id: string }>(
      `SELECT DISTINCT item_id FROM item_source_tags
        WHERE item_id IN (${ph}) AND category IN ('genre', 'freeform') AND lower(name) = ?`,
      [...ids, ROMANCE_TAG],
    ).map((r) => r.item_id),
  )

  const buckets: Record<
    string,
    { ao3: { term: string; weight: number }[]; raw: { term: string; weight: number }[] }
  > = {
    relationship: { ao3: [], raw: [] },
    character: { ao3: [], raw: [] },
    fandom: { ao3: [], raw: [] },
  }
  const romanceChar = {
    ao3: [] as { term: string; weight: number }[],
    raw: [] as { term: string; weight: number }[],
  }
  for (const r of all<{ item_id: string; name: string; category: string; is_ao3: number }>(
    `SELECT t.item_id, t.name, t.category,
            CASE WHEN i.source_url LIKE ? THEN 1 ELSE 0 END AS is_ao3
       FROM item_source_tags t JOIN items i ON i.id = t.item_id
      WHERE t.item_id IN (${ph})
        AND t.category IN ('relationship', 'character', 'fandom')`,
    [AO3_HOST_LIKE, ...ids],
  )) {
    const bucket = buckets[r.category]
    if (!bucket) continue
    const entry = { term: r.name, weight: weightById.get(r.item_id) ?? 0 }
    ;(r.is_ao3 ? bucket.ao3 : bucket.raw).push(entry)
    // A character from a romance fic also feeds the pairing-inference pool.
    if (r.category === 'character' && romanceIds.has(r.item_id)) {
      ;(r.is_ao3 ? romanceChar.ao3 : romanceChar.raw).push(entry)
    }
  }

  const split = (b: {
    ao3: { term: string; weight: number }[]
    raw: { term: string; weight: number }[]
  }): RawSplit => ({
    canonical: aggregate(b.ao3),
    raw: aggregate(b.raw),
  })
  return {
    relationships: split(buckets.relationship),
    characters: split(buckets.character),
    fandoms: split(buckets.fandom),
    romanceCharacters: split(romanceChar),
  }
}

// ── length / completion taste profile ─────────────────────────────────────────
// The soft band the AO3 source applies (word_count range + complete) ONLY when the
// user's liked fics are clearly skewed — otherwise no length filter, so both short-
// and long-fic readers are honored. Derived from item_source_meta (words/status),
// the F1 stats that were persisted-but-unused until now.

const LENGTH_BANDS = {
  MIN_SAMPLE: 3, // need this many measured fics before inferring a band
  LONG_WORDS: 40000, // ≥ this counts as a "long" fic
  SHORT_WORDS: 20000, // < this counts as a "short" fic
  SKEW: 0.7, // fraction of one side that makes the taste "clearly skewed"
}

/** A soft query band: absent fields mean "don't filter that dimension". */
export interface LengthProfile {
  /** Only fics longer than this (words) — set when the reader clearly prefers long. */
  wordFloor?: number
  /** Only fics shorter than this (words) — set when the reader clearly prefers short. */
  wordCeil?: number
  /** Restrict to completed works — set when the reader clearly prefers complete. */
  completeOnly: boolean
}

/**
 * Infer the length/completion band from the liked fics' stored stats. Applies a
 * word floor/ceiling only when ≥SKEW of measured fics fall on one side, and
 * `completeOnly` only when ≥SKEW are complete — with a minimum sample so a
 * one-or-two-fic library never over-filters. Reads the db; caller is the AO3 source.
 */
export function buildLengthProfile(liked: LikedItem[], cfg = LENGTH_BANDS): LengthProfile {
  const profile: LengthProfile = { completeOnly: false }
  const top = liked.filter((l) => l.weight > 0).slice(0, SEED_SOURCE_LIMIT)
  if (top.length === 0) return profile
  const ids = top.map((l) => l.id)
  const ph = placeholders(ids.length)

  const rows = all<{ words: number | null; status: string | null }>(
    `SELECT words, status FROM item_source_meta WHERE item_id IN (${ph})`,
    ids,
  )
  const words = rows.map((r) => r.words).filter((w): w is number => typeof w === 'number' && w > 0)
  const statuses = rows.map((r) => r.status).filter((s): s is string => !!s)

  if (words.length >= cfg.MIN_SAMPLE) {
    const long = words.filter((w) => w >= cfg.LONG_WORDS).length / words.length
    const short = words.filter((w) => w < cfg.SHORT_WORDS).length / words.length
    if (long >= cfg.SKEW) profile.wordFloor = cfg.LONG_WORDS
    else if (short >= cfg.SKEW) profile.wordCeil = cfg.SHORT_WORDS
  }
  if (statuses.length >= cfg.MIN_SAMPLE) {
    const complete = statuses.filter((s) => s === 'complete').length / statuses.length
    if (complete >= cfg.SKEW) profile.completeOnly = true
  }
  return profile
}
