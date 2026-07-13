import { candidateKey, type Candidate, type SourceName } from './candidates'
import type { LikedItem } from './taste'

// F4 — the candidate-source seam. `recommend()` fans out to a list of sources
// (OpenLibrary books, AO3 fics, later FFN), each of which turns the liked set
// into its own catalog's candidates, then unions + dedups the pools and reranks
// the merged result with the taste vector. Adding a catalog = implement one more
// CandidateSource; the whole downstream pipeline is source-agnostic (it only sees
// Candidate[]). Sources are injected into recommend(), so the orchestrator tests
// stub them and never touch the network.

/** Per-call fetch options. `fresh` = a user-initiated Refresh: the source uses its
 *  shorter SOFT_FLOOR_MS as the effective cache-staleness threshold instead of its
 *  hard TTL, so an aged pool re-scrapes. Omitted/false = serve cache up to the TTL. */
export interface FetchOpts {
  fresh?: boolean
}

export interface CandidateSource {
  name: SourceName
  /** Turn the liked items into this catalog's candidates. Must resolve to [] on failure. */
  fetch(liked: LikedItem[], opts?: FetchOpts): Promise<Candidate[]>
}

/**
 * Merge candidates from several sources, dropping cross-source duplicates. A
 * candidate is a dup if it shares a `sourceId` OR a normalized `title|author`
 * key with one already kept (so a fic and a same-title book collapse to one).
 * First occurrence wins — order the sources so the preferred catalog comes first.
 */
export function unionCandidates(pools: Candidate[][]): Candidate[] {
  const out: Candidate[] = []
  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  for (const pool of pools) {
    for (const c of pool) {
      const key = candidateKey(c.title, c.author)
      if (seenIds.has(c.sourceId) || seenKeys.has(key)) continue
      seenIds.add(c.sourceId)
      seenKeys.add(key)
      out.push(c)
    }
  }
  return out
}
