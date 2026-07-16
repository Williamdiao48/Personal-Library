import type { TasteSeeds, WeightedTerm } from './tasteSeeds'

// The compact, deterministic reader description the LLM book-reranker judges
// candidates against. Built purely from buildTasteSeeds() output — data recommend()
// already computes for the "why" chips — so it adds ZERO IO. Only the strongest few
// terms per category are included: enough to characterize taste without bloating the
// prompt (or leaking the whole library). Deterministic so the reranker's input never
// varies for the same library. An LLM-authored natural-language profile is a noted
// follow-up; v1 stays deterministic for robustness.

export const DIGEST_CAPS = {
  authors: 6,
  genres: 8,
  fandoms: 6,
  freeforms: 8,
} as const

/** The strongest `cap` terms of a category, comma-joined (already heaviest-first). */
function names(terms: WeightedTerm[], cap: number): string {
  return terms
    .slice(0, cap)
    .map((t) => t.term)
    .join(', ')
}

/**
 * A short, human-readable taste description — strongest signals first, one labeled
 * line per non-empty category. Returns '' when there is nothing to say (thin taste);
 * the caller then skips the LLM rerank entirely (no taste to judge fit against, so
 * the model would only guess). Pure.
 */
export function buildTasteDigest(seeds: TasteSeeds, caps = DIGEST_CAPS): string {
  const lines: string[] = []
  const push = (label: string, terms: WeightedTerm[], cap: number): void => {
    const s = names(terms, cap)
    if (s) lines.push(`${label}: ${s}`)
  }
  push('Favorite authors', seeds.authors, caps.authors)
  push('Genres', seeds.genres, caps.genres)
  push('Fandoms', seeds.fandoms, caps.fandoms)
  push('Themes and tags', seeds.freeforms, caps.freeforms)
  return lines.join('\n')
}
