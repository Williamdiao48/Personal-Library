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
