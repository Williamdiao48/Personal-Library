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
  MAX_SUBJECTS: 6, // top-N tag→subject queries
  MAX_AUTHORS: 4, // top-N author queries
} as const

/** Strip embedded quotes and collapse whitespace so the term is safe to wrap in `"…"`. */
function clean(term: string): string {
  return term.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
}

type Aggregated = { display: string; weight: number }

/**
 * Sum weights per term, case-insensitively (keeping the first-seen casing), and
 * return them heaviest-first. Ties break alphabetically so the output is
 * deterministic (stable cache keys, stable eyeball-gate runs). Empty terms drop.
 */
function aggregate(entries: { term: string; weight: number }[]): Aggregated[] {
  const map = new Map<string, Aggregated>()
  for (const { term, weight } of entries) {
    const display = clean(term)
    if (!display) continue
    const key = display.toLowerCase()
    const cur = map.get(key)
    if (cur) cur.weight += weight
    else map.set(key, { display, weight })
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
    for (const t of s.tags) tagEntries.push({ term: t, weight: s.weight })
    if (s.author) authorEntries.push({ term: s.author, weight: s.weight })
  }

  const subjects = aggregate(tagEntries).slice(0, cfg.MAX_SUBJECTS)
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
