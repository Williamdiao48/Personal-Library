// C4.2 — query seeding (§8). The taste *vector* can't be sent to a keyword API,
// so we seed OpenLibrary from the *source items'* metadata: collect the tags and
// authors of the highest-weight liked items, weight each term by the summed
// affinity of the items it came from, and emit the top few as fielded
// `subject:"…"` / `author:"…"` queries. Pure + ABI-agnostic (the orchestrator in
// C4.4 joins buildTaste().liked to each item's tags/author and passes them in).
//
// Fanfic-tag caveat (§8): AO3-style tags ("Enemies to Lovers", "Hurt/Comfort")
// don't map cleanly onto OpenLibrary book *subjects*, so for a fanfic-heavy
// library these seeds are weak and the vector rerank (C4.4) does most of the work.
// v1 passes tags through unmodified; a tag→subject map is a Chunk-6 tuning concern.

import { canonicalSubjectKey } from './subjectNormalize'

/** One liked item's seed contribution: its author, its tags, and its affinity weight. */
export interface SeedSource {
  author: string | null
  tags: string[]
  weight: number
}

export type SeedKind = 'subject' | 'author'

export interface SeedQuery {
  kind: SeedKind
  /** The raw term (cleaned), for cache keys / debugging. */
  term: string
  /** The OpenLibrary `q` value, e.g. `subject:"Fantasy"`. */
  q: string
  /** Summed affinity of the items this term came from. */
  weight: number
}

export const SEED = {
  // Subjects lead, authors are a deliberate minority: with owned books now resolved
  // to real OpenLibrary subjects (ownedBookSubjects.ts), subject: queries carry the
  // cross-author discovery, while a couple of author: queries still surface the
  // occasional new title from a favorite author (not "more of the same" flooding).
  MAX_SUBJECTS: 10, // top-N tag/subject→subject queries
  MAX_AUTHORS: 2, // top-N author queries
} as const

/** Strip embedded quotes and collapse whitespace so the term is safe to wrap in `"…"`. */
function clean(term: string): string {
  return term.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
}

// Non-discriminative subject terms that make TERRIBLE `subject:` seeds. Owned-book
// subjects (ownedBookSubjects.ts) fold OpenLibrary's raw tags into the seed pool, and
// those include broad format/classification labels — a `subject:"Fiction"` query returns
// the entire catalog as noise, `subject:"Juvenile Fiction"` floods with unrelated kids'
// books — plus OpenLibrary metadata artifacts (`nyt:…`, `series:…`, reading-level tags)
// that aren't real subjects at all. Dropping them concentrates the seed budget
// (MAX_SUBJECTS) on TOPICAL subjects ("Wizards", "Spies", "Kings and rulers") that
// actually discriminate taste. This is upstream of the candidate content-type gate: it
// stops the junk being fetched, rather than filtering it after. (2026-08-26 rework.)
const SUBJECT_STOPWORDS = new Set([
  'fiction',
  'nonfiction',
  'non-fiction',
  'juvenile fiction',
  'juvenile literature',
  'juvenile works',
  'juvenile audience',
  'juvenile',
  "children's fiction",
  "children's literature",
  "children's stories",
  "children's books",
  'childrens',
  'children',
  'young adult fiction',
  'young adult',
  'teen fiction',
  'middle grade',
  'general',
  'classics',
  'literature',
  'english literature',
  'english fiction',
  'fiction, fantasy, general',
  'large type books',
  'accessible book',
])

// OpenLibrary metadata artifacts and locale/format noise that leak into the subject list
// but are not real subjects (`nyt:combined-print…`, `series:Mistborn`, `Reading Level-Grade 9`).
const SUBJECT_STOP_RE =
  /^(nyt:|series:|form:|genre:|award:|subject:|lc:|ddc:|reading level|open library staff|new york times|translat|romans, nouvelles)/i

/** A subject term worth turning into a `subject:` query — topical, not a broad
 * format/classification label or an OpenLibrary metadata artifact. */
export function isDiscriminativeSubject(term: string): boolean {
  const t = term.toLowerCase()
  return t.length > 1 && !SUBJECT_STOPWORDS.has(t) && !SUBJECT_STOP_RE.test(t)
}

type Aggregated = { display: string; weight: number }

/**
 * Sum weights per term and return them heaviest-first. Ties break alphabetically so
 * the output is deterministic (stable cache keys, stable eyeball-gate runs). Empty
 * terms drop. `keyOf` sets the identity two terms collapse under (default =
 * case-insensitive); on collision the SHORTER display wins (so a subject's bare topic
 * "Bears" beats the "Bears, Fiction" variant), ties keeping the first seen.
 */
function aggregate(
  entries: { term: string; weight: number }[],
  keyOf: (display: string) => string = (d) => d.toLowerCase(),
): Aggregated[] {
  const map = new Map<string, Aggregated>()
  for (const { term, weight } of entries) {
    const display = clean(term)
    if (!display) continue
    const key = keyOf(display)
    const cur = map.get(key)
    if (cur) {
      cur.weight += weight
      if (display.length < cur.display.length) cur.display = display
    } else map.set(key, { display, weight })
  }
  return [...map.values()].sort((a, b) => b.weight - a.weight || a.display.localeCompare(b.display))
}

function fielded(kind: SeedKind, term: string): string {
  return `${kind}:"${term}"`
}

/**
 * Build the OpenLibrary seed queries from the liked sources: the top
 * `MAX_SUBJECTS` tags (as `subject:` queries) and top `MAX_AUTHORS` authors (as
 * `author:` queries), each weighted by the summed affinity of its source items.
 * Non-positive-weight sources are skipped (only likes seed queries).
 */
export function buildSeedQueries(sources: SeedSource[], cfg = SEED): SeedQuery[] {
  const tagEntries: { term: string; weight: number }[] = []
  const authorEntries: { term: string; weight: number }[] = []
  for (const s of sources) {
    if (s.weight <= 0) continue
    // Drop non-discriminative format labels / OL metadata artifacts before they become
    // `subject:` queries (see SUBJECT_STOPWORDS) — keeps the seed budget on topical tags.
    for (const t of s.tags) {
      if (isDiscriminativeSubject(clean(t))) tagEntries.push({ term: t, weight: s.weight })
    }
    if (s.author) authorEntries.push({ term: s.author, weight: s.weight })
  }

  // Subjects aggregate under their canonical key so "Bears" and "Bears, Fiction"
  // sum into ONE seed (weights combined) instead of spending two of MAX_SUBJECTS on
  // the same topic; authors keep the plain case-insensitive identity.
  const subjects = aggregate(tagEntries, canonicalSubjectKey).slice(0, cfg.MAX_SUBJECTS)
  const authors = aggregate(authorEntries).slice(0, cfg.MAX_AUTHORS)

  const queries: SeedQuery[] = []
  for (const a of subjects) {
    queries.push({
      kind: 'subject',
      term: a.display,
      q: fielded('subject', a.display),
      weight: a.weight,
    })
  }
  for (const a of authors) {
    queries.push({
      kind: 'author',
      term: a.display,
      q: fielded('author', a.display),
      weight: a.weight,
    })
  }
  return queries
}
