import { get, run } from '../db'
import { fetchJson } from '../capture/fetch'
import type { WeightedTerm, Ao3RawSeeds, Ao3TagSeeds } from './tasteSeeds'

// The vocab bridge. FFN captures use abbreviated tag names ("Harry P.", "Fleur D.",
// "Harry P./Fleur D.") that AO3's EXACT named search fields don't match — feeding
// them in returns ~0 (the cross-domain mismatch). But AO3's own autocomplete
// endpoint resolves each abbreviation to its canonical tag as the top hit
// ("Harry Potter", "Fleur Delacour", "Fleur Delacour/Harry Potter"), so we let AO3
// canonicalize for us: resolve each raw term once, cache it persistently in
// tag_alias, and merge the results into the canonical named-field seeds. Zero hand-
// maintained map; a term hits the network at most once per TTL. parseAutocompleteTop
// is pure; resolveAo3Tag touches the network + cache.

const AO3_ORIGIN = 'https://archiveofourown.org'

export type AliasKind = 'character' | 'relationship' | 'fandom'

export const RESOLVE = {
  MAX_RELATIONSHIPS: 4, // cap raw terms resolved per category (bounds the network)
  MAX_CHARACTERS: 6,
  MAX_FANDOMS: 3,
  MAX_PAIRINGS: 4, // cap protagonist-anchored pairings synthesized from co-listed chars
  TTL_MS: 90 * 24 * 60 * 60 * 1000, // canonical tags are stable — cache hard (90d)
  NEG_TTL_MS: 7 * 24 * 60 * 60 * 1000, // retry a failed/empty resolution after a week
  DELAY_MS: 300, // polite delay before each real autocomplete fetch
  // Autocomplete is a lightweight endpoint (healthy replies are sub-second) and up
  // to ~23 of these run serially, so cap the per-call tail: 1 retry × a short
  // timeout instead of fetchJson's default 2×15s (~46s) that could stall a refresh.
  FETCH_RETRIES: 1,
  FETCH_TIMEOUT_MS: 8_000,
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Top canonical name from an AO3 autocomplete JSON body, or null. Pure. */
export function parseAutocompleteTop(body: string): string | null {
  try {
    const arr = JSON.parse(body)
    if (!Array.isArray(arr)) return null
    for (const x of arr) {
      const name = typeof x?.name === 'string' ? x.name.trim() : ''
      if (name) return name
    }
    return null
  } catch {
    return null
  }
}

// Throws on a fetch failure (so the caller can skip caching a transient error);
// returns null only for a genuine empty autocomplete result.
async function fetchAutocompleteTop(kind: AliasKind, term: string): Promise<string | null> {
  const url = `${AO3_ORIGIN}/autocomplete/${kind}?term=${encodeURIComponent(term)}`
  return parseAutocompleteTop(await fetchJson(url, RESOLVE.FETCH_RETRIES, RESOLVE.FETCH_TIMEOUT_MS))
}

/**
 * Resolve a raw (possibly abbreviated) tag to its canonical AO3 name via
 * autocomplete, cache-first. A hit within TTL is served from tag_alias — including
 * a cached `null` (negative cache, shorter NEG_TTL so a transient failure retries).
 * On a miss, one autocomplete fetch (after a polite delay), then persist. Touches
 * the network + cache.
 */
export async function resolveAo3Tag(
  kind: AliasKind,
  rawTerm: string,
  opts: { now?: number; ttlMs?: number; negTtlMs?: number; delayMs?: number } = {},
): Promise<string | null> {
  const term = rawTerm.trim()
  if (!term) return null
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? RESOLVE.TTL_MS
  const negTtlMs = opts.negTtlMs ?? RESOLVE.NEG_TTL_MS
  const delayMs = opts.delayMs ?? RESOLVE.DELAY_MS

  const row = get<{ canonical: string | null; resolved_at: number }>(
    `SELECT canonical, resolved_at FROM tag_alias WHERE raw = ? AND kind = ?`,
    [term, kind],
  )
  if (row) {
    const age = now - row.resolved_at
    if (row.canonical ? age <= ttlMs : age <= negTtlMs) return row.canonical
  }

  if (delayMs > 0) await sleep(delayMs)
  let canonical: string | null
  try {
    canonical = await fetchAutocompleteTop(kind, term)
  } catch {
    return null // transient fetch failure — do NOT cache, so it retries next run
  }
  run(
    `INSERT INTO tag_alias (raw, kind, canonical, resolved_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(raw, kind) DO UPDATE SET canonical = excluded.canonical, resolved_at = excluded.resolved_at`,
    [term, kind, canonical, now],
  )
  return canonical
}

/**
 * From an AO3 relationship-autocomplete body, the canonical tag that is EXACTLY the
 * romantic pairing of `a` and `b` — i.e. their two names joined by `/` (not `&`, not
 * a 3+-way tag), in either order. This is what makes co-listed characters a usable
 * pairing signal without false positives: a real ship (`Susan Bones/Harry Potter`)
 * matches, an impossible combo (`Harry/Vernon`) yields nothing. Pure.
 */
export function parsePairingMatch(body: string, a: string, b: string): string | null {
  try {
    const arr = JSON.parse(body)
    if (!Array.isArray(arr)) return null
    const want = new Set([a, b])
    for (const x of arr) {
      const name = typeof x?.name === 'string' ? x.name.trim() : ''
      if (!name || name.includes('&')) continue
      const parts = name.split('/').map((s) => s.trim())
      if (parts.length === 2 && new Set(parts).size === 2 && parts.every((p) => want.has(p))) {
        return name
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Validate + canonicalize a synthesized pairing of two CANONICAL character names via
 * AO3's relationship autocomplete: returns the canonical 2-person ship tag (correctly
 * ordered) if AO3 has one, else null (so a non-pairing combo is dropped). Cache-first
 * in tag_alias (kind `pairing`, key = the two names sorted). Resolving the characters
 * to canonical FIRST (upstream) is what avoids the abbreviation-ambiguity that made a
 * raw "Harry P./Susan B." mis-resolve. Touches the network + cache.
 */
export async function resolvePairing(
  a: string,
  b: string,
  opts: { now?: number; ttlMs?: number; negTtlMs?: number; delayMs?: number } = {},
): Promise<string | null> {
  const [x, y] = [a.trim(), b.trim()]
  if (!x || !y || x === y) return null
  const key = [x, y].sort((m, n) => m.localeCompare(n)).join(' / ')
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? RESOLVE.TTL_MS
  const negTtlMs = opts.negTtlMs ?? RESOLVE.NEG_TTL_MS
  const delayMs = opts.delayMs ?? RESOLVE.DELAY_MS

  const row = get<{ canonical: string | null; resolved_at: number }>(
    `SELECT canonical, resolved_at FROM tag_alias WHERE raw = ? AND kind = 'pairing'`,
    [key],
  )
  if (row) {
    const age = now - row.resolved_at
    if (row.canonical ? age <= ttlMs : age <= negTtlMs) return row.canonical
  }

  if (delayMs > 0) await sleep(delayMs)
  let canonical: string | null
  try {
    const url = `${AO3_ORIGIN}/autocomplete/relationship?term=${encodeURIComponent(`${x}/${y}`)}`
    canonical = parsePairingMatch(
      await fetchJson(url, RESOLVE.FETCH_RETRIES, RESOLVE.FETCH_TIMEOUT_MS),
      x,
      y,
    )
  } catch {
    return null // transient fetch failure — do NOT cache, so it retries next run
  }
  run(
    `INSERT INTO tag_alias (raw, kind, canonical, resolved_at) VALUES (?, 'pairing', ?, ?)
     ON CONFLICT(raw, kind) DO UPDATE SET canonical = excluded.canonical, resolved_at = excluded.resolved_at`,
    [key, canonical, now],
  )
  return canonical
}

/**
 * Infer pairings from co-listed characters — FFN authors frequently skip the
 * `[bracket]` pairing tag, so the character list is the real romance signal. Anchors
 * on the protagonist (the heaviest character, present across the most fics) and pairs
 * them with each other top character, validated against AO3's canonical ships (so
 * non-pairings and cross-fandom combos drop out). Weight = the partner's affinity.
 */
async function inferPairings(
  characters: WeightedTerm[],
  opts: Parameters<typeof resolvePairing>[2],
): Promise<WeightedTerm[]> {
  if (characters.length < 2) return []
  const [protagonist, ...rest] = characters
  const out: WeightedTerm[] = []
  for (const other of rest.slice(0, RESOLVE.MAX_PAIRINGS)) {
    const canonical = await resolvePairing(protagonist.term, other.term, opts)
    if (canonical) out.push({ term: canonical, weight: other.weight })
  }
  return out
}

/** Sum weights per exact term across lists, heaviest-first (alpha tie-break). Pure. */
function mergeWeighted(...lists: WeightedTerm[][]): WeightedTerm[] {
  const map = new Map<string, number>()
  for (const list of lists) {
    for (const t of list) map.set(t.term, (map.get(t.term) ?? 0) + t.weight)
  }
  return [...map.entries()]
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
}

/**
 * Append `extra` terms not already in `base`, preserving both lists' order — so a
 * lower-tier list fills the slots *after* the higher-tier one regardless of weight,
 * without duplicating a term the two share. Pure.
 */
function appendNew(base: WeightedTerm[], extra: WeightedTerm[]): WeightedTerm[] {
  const seen = new Set(base.map((t) => t.term))
  return [...base, ...extra.filter((t) => !seen.has(t.term))]
}

/** Resolve up to `max` raw terms, partitioning into resolved (canonical) + unresolved. */
async function resolveList(
  kind: AliasKind,
  rawList: WeightedTerm[],
  max: number,
  opts: Parameters<typeof resolveAo3Tag>[2],
): Promise<{ resolved: WeightedTerm[]; unresolved: WeightedTerm[] }> {
  const resolved: WeightedTerm[] = []
  const unresolved: WeightedTerm[] = []
  for (const t of rawList.slice(0, max)) {
    const canonical = await resolveAo3Tag(kind, t.term, opts)
    if (canonical) resolved.push({ term: canonical, weight: t.weight })
    else unresolved.push(t)
  }
  return { resolved, unresolved }
}

/**
 * Turn the origin-split raw seeds into the final canonical Ao3TagSeeds the query
 * builder consumes: each named-field category = its already-canonical terms merged
 * with the autocomplete-resolved raw terms. Raw relationships/characters that can't
 * be resolved are DROPPED (an abbreviated name in a named field zeroes out AO3);
 * raw fandoms that can't be resolved fall through to `fandomsFreeText` (the fuzzy
 * free-text query tolerates short fandom names). Touches the network + cache.
 */
export async function resolveAo3Seeds(
  raw: Ao3RawSeeds,
  opts: Parameters<typeof resolveAo3Tag>[2] = {},
): Promise<Ao3TagSeeds> {
  const rel = await resolveList(
    'relationship',
    raw.relationships.raw,
    RESOLVE.MAX_RELATIONSHIPS,
    opts,
  )
  const chr = await resolveList('character', raw.characters.raw, RESOLVE.MAX_CHARACTERS, opts)
  const fan = await resolveList('fandom', raw.fandoms.raw, RESOLVE.MAX_FANDOMS, opts)

  const characters = mergeWeighted(raw.characters.canonical, chr.resolved)

  // FFN authors often skip the [bracket] pairing tag, so co-listed characters are the
  // real romance signal — synthesize + validate pairings from them (D: character
  // co-occurrence → pairing). But only within a *romance* fic: two characters sharing an
  // adventure/gen fic are just two characters, so inference draws solely from the
  // romance-fic character pool (resolving reuses the tag_alias cache — no extra fetches).
  // The net is deliberately wide (precision is the reranker's job downstream), but a
  // *guessed* ship must never outrank one the reader actually captured: real
  // relationships (canonical + autocomplete-resolved) always lead, and inferred pairings
  // only fill the slots after them. So the system quietly improves as AO3 fics are added
  // — canonical ships take over and inference recedes to a fallback.
  const romChr = await resolveList(
    'character',
    raw.romanceCharacters.raw,
    RESOLVE.MAX_CHARACTERS,
    opts,
  )
  const romanceCharacters = mergeWeighted(raw.romanceCharacters.canonical, romChr.resolved)
  const inferred = await inferPairings(romanceCharacters, opts)

  return {
    relationships: appendNew(
      mergeWeighted(raw.relationships.canonical, rel.resolved),
      mergeWeighted(inferred),
    ),
    characters,
    fandoms: mergeWeighted(raw.fandoms.canonical, fan.resolved),
    fandomsFreeText: fan.unresolved, // fandoms with no canonical form → free-text fallback
  }
}
