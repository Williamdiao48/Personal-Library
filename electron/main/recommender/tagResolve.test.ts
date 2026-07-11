import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The resolver's only impure edges are fetchJson (AO3 autocomplete — a JSON/XHR
// endpoint) + tag_alias (DB). Mock fetchJson and drive the real cache / merge logic
// against an in-memory DB (Node ABI). parseAutocompleteTop is pure.
vi.mock('../capture/fetch', () => ({ fetchJson: vi.fn() }))

import { openTestDb, closeTestDb, type TestDb } from '../../../test/db/harness'
import { fetchJson } from '../capture/fetch'
import {
  parseAutocompleteTop,
  parsePairingMatch,
  resolveAo3Tag,
  resolvePairing,
  resolveAo3Seeds,
  RESOLVE,
} from './tagResolve'
import type { Ao3RawSeeds } from './tasteSeeds'

const mockFetchPage = vi.mocked(fetchJson)
const json = (names: string[]): string => JSON.stringify(names.map((name) => ({ id: name, name })))

// ── parseAutocompleteTop (pure) ───────────────────────────────────────────────
describe('parseAutocompleteTop', () => {
  it('returns the first non-empty name, or null for empty/garbage', () => {
    expect(parseAutocompleteTop(json(['Harry Potter', 'Harry Styles']))).toBe('Harry Potter')
    expect(parseAutocompleteTop(json([]))).toBeNull()
    expect(parseAutocompleteTop('[{"name":"  "},{"name":"Fleur Delacour"}]')).toBe('Fleur Delacour')
    expect(parseAutocompleteTop('not json')).toBeNull()
    expect(parseAutocompleteTop('{"name":"x"}')).toBeNull() // not an array
  })
})

// ── resolveAo3Tag (network + cache) ───────────────────────────────────────────
describe('resolveAo3Tag', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
  })
  afterEach(() => closeTestDb())

  it('resolves via autocomplete, caches, and serves the hit without re-fetching', async () => {
    mockFetchPage.mockResolvedValue(json(['Harry Potter']))
    expect(await resolveAo3Tag('character', 'Harry P.', { now: 1000, delayMs: 0 })).toBe(
      'Harry Potter',
    )
    // the autocomplete URL is scoped by kind and carries the raw term
    expect(mockFetchPage.mock.calls[0][0]).toContain('/autocomplete/character?term=')

    expect(await resolveAo3Tag('character', 'Harry P.', { now: 2000, delayMs: 0 })).toBe(
      'Harry Potter',
    )
    expect(mockFetchPage).toHaveBeenCalledTimes(1) // cache hit
  })

  it('negative-caches an empty resolution and retries only after NEG_TTL', async () => {
    mockFetchPage.mockResolvedValue(json([]))
    expect(
      await resolveAo3Tag('relationship', 'Nonsense Ship', { now: 1000, delayMs: 0 }),
    ).toBeNull()
    // within NEG_TTL → served from the negative cache, no refetch
    await resolveAo3Tag('relationship', 'Nonsense Ship', {
      now: 1000 + RESOLVE.NEG_TTL_MS,
      delayMs: 0,
    })
    expect(mockFetchPage).toHaveBeenCalledTimes(1)
    // past NEG_TTL → refetch
    await resolveAo3Tag('relationship', 'Nonsense Ship', {
      now: 1000 + RESOLVE.NEG_TTL_MS + 1,
      delayMs: 0,
    })
    expect(mockFetchPage).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache a transient fetch failure — so it retries next run', async () => {
    // A thrown fetch (e.g. AO3 525) must not poison the cache with a false negative.
    mockFetchPage.mockRejectedValueOnce(new Error('525')).mockResolvedValue(json(['Harry Potter']))
    expect(await resolveAo3Tag('character', 'Harry P.', { now: 1000, delayMs: 0 })).toBeNull()
    expect(await resolveAo3Tag('character', 'Harry P.', { now: 1001, delayMs: 0 })).toBe(
      'Harry Potter',
    )
    expect(mockFetchPage).toHaveBeenCalledTimes(2) // retried, not served from a poisoned cache
  })

  it('re-resolves a canonical hit only after the (long) positive TTL', async () => {
    mockFetchPage.mockResolvedValue(json(['Fleur Delacour']))
    await resolveAo3Tag('character', 'Fleur D.', { now: 1000, delayMs: 0 })
    await resolveAo3Tag('character', 'Fleur D.', { now: 1000 + RESOLVE.TTL_MS, delayMs: 0 }) // still fresh
    expect(mockFetchPage).toHaveBeenCalledTimes(1)
    await resolveAo3Tag('character', 'Fleur D.', { now: 1000 + RESOLVE.TTL_MS + 1, delayMs: 0 })
    expect(mockFetchPage).toHaveBeenCalledTimes(2)
  })
})

// ── parsePairingMatch (pure) ──────────────────────────────────────────────────
describe('parsePairingMatch', () => {
  it('returns the exact 2-person / ship (either order), rejects &/3-way/wrong-partner', () => {
    const body = json([
      'Astoria Greengrass/Daphne Greengrass/Harry Potter', // 3-way → reject
      'Daphne Greengrass & Harry Potter', // platonic & → reject
      'Daphne Greengrass/Harry Potter', // the ship → match
    ])
    expect(parsePairingMatch(body, 'Harry Potter', 'Daphne Greengrass')).toBe(
      'Daphne Greengrass/Harry Potter',
    )
    // order-insensitive on the inputs
    expect(parsePairingMatch(body, 'Daphne Greengrass', 'Harry Potter')).toBe(
      'Daphne Greengrass/Harry Potter',
    )
    expect(parsePairingMatch(json([]), 'Harry Potter', 'Vernon Dursley')).toBeNull()
    expect(
      parsePairingMatch(json(['Harry Potter/Ginny Weasley']), 'Harry Potter', 'Daphne Greengrass'),
    ).toBeNull() // wrong partner
    expect(parsePairingMatch('not json', 'a', 'b')).toBeNull()
  })
})

// ── resolvePairing (network + cache) ──────────────────────────────────────────
describe('resolvePairing', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
  })
  afterEach(() => closeTestDb())

  it('returns the canonical ship, caches order-insensitively, negative-caches a non-pairing', async () => {
    mockFetchPage.mockResolvedValue(
      json(['Daphne Greengrass & Harry Potter', 'Daphne Greengrass/Harry Potter']),
    )
    expect(
      await resolvePairing('Harry Potter', 'Daphne Greengrass', { now: 1000, delayMs: 0 }),
    ).toBe('Daphne Greengrass/Harry Potter')
    // same pair in the other order → cache hit (sorted key), no refetch
    expect(
      await resolvePairing('Daphne Greengrass', 'Harry Potter', { now: 2000, delayMs: 0 }),
    ).toBe('Daphne Greengrass/Harry Potter')
    expect(mockFetchPage).toHaveBeenCalledTimes(1)

    mockFetchPage.mockResolvedValue(json(['Susan Reynolds (b.1785)/Mary Seabury (b.1761)']))
    expect(
      await resolvePairing('Harry Potter', 'Vernon Dursley', { now: 1000, delayMs: 0 }),
    ).toBeNull()
  })
})

// ── resolveAo3Seeds (merge + partition) ───────────────────────────────────────
describe('resolveAo3Seeds', () => {
  let db: TestDb
  beforeEach(() => {
    db = openTestDb()
    mockFetchPage.mockReset()
    // Map each raw term to its canonical top hit (or [] = unresolvable).
    const map: Record<string, string[]> = {
      'Harry P./Fleur D.': ['Fleur Delacour/Harry Potter'],
      'Bad Ship': [],
      'Harry P.': ['Harry Potter'],
      Naruto: [],
    }
    mockFetchPage.mockImplementation(async (url: string) => {
      const term = decodeURIComponent(new URL(url).searchParams.get('term') ?? '')
      return json(map[term] ?? [])
    })
  })
  afterEach(() => closeTestDb())

  it('merges resolved raw terms into canonical, drops unresolvable rel/char, routes fandom to free-text', async () => {
    const raw: Ao3RawSeeds = {
      relationships: {
        canonical: [{ term: 'Hermione Granger/Draco Malfoy', weight: 1 }],
        raw: [
          { term: 'Harry P./Fleur D.', weight: 3 }, // → canonical, merged
          { term: 'Bad Ship', weight: 5 }, // unresolvable → dropped
        ],
      },
      characters: { canonical: [], raw: [{ term: 'Harry P.', weight: 2 }] },
      fandoms: { canonical: [], raw: [{ term: 'Naruto', weight: 1 }] }, // unresolvable → free-text
      romanceCharacters: { canonical: [], raw: [] },
    }

    const seeds = await resolveAo3Seeds(raw, { delayMs: 0 })
    expect(seeds.relationships).toEqual([
      { term: 'Fleur Delacour/Harry Potter', weight: 3 }, // resolved, heaviest
      { term: 'Hermione Granger/Draco Malfoy', weight: 1 }, // pre-canonical
    ])
    expect(seeds.characters).toEqual([{ term: 'Harry Potter', weight: 2 }])
    expect(seeds.fandoms).toEqual([]) // Naruto didn't resolve
    expect(seeds.fandomsFreeText).toEqual([{ term: 'Naruto', weight: 1 }]) // → fuzzy fallback
  })

  it('synthesizes protagonist-anchored pairings from co-listed characters (FFN has no bracket)', async () => {
    // Character autocomplete resolves the abbreviations; relationship autocomplete
    // validates the protagonist×partner ships. Susan is a real ship; "Ron" is not.
    mockFetchPage.mockReset()
    mockFetchPage.mockImplementation(async (url: string) => {
      const u = new URL(url)
      const term = decodeURIComponent(u.searchParams.get('term') ?? '')
      if (u.pathname.endsWith('/character')) {
        return json(
          {
            'Harry P.': ['Harry Potter'],
            'Fleur D.': ['Fleur Delacour'],
            'Ron W.': ['Ron Weasley'],
          }[term] ?? [],
        )
      }
      // relationship autocomplete: only Harry×Fleur is a (validated) ship here
      if (term === 'Harry Potter/Fleur Delacour') {
        return json(['Fleur Delacour & Harry Potter', 'Fleur Delacour/Harry Potter'])
      }
      return json([]) // Harry/Ron → no 2-person ship → dropped
    })

    const chars = {
      canonical: [] as { term: string; weight: number }[],
      raw: [
        { term: 'Harry P.', weight: 5 }, // protagonist (heaviest)
        { term: 'Fleur D.', weight: 2 },
        { term: 'Ron W.', weight: 1 },
      ],
    }
    const raw: Ao3RawSeeds = {
      relationships: { canonical: [], raw: [] },
      characters: chars,
      fandoms: { canonical: [], raw: [] },
      romanceCharacters: chars, // these characters came from a romance fic → eligible
    }

    const seeds = await resolveAo3Seeds(raw, { delayMs: 0 })
    // pairing synthesized from the character list, weighted by the partner's affinity
    expect(seeds.relationships).toEqual([{ term: 'Fleur Delacour/Harry Potter', weight: 2 }])
    expect(seeds.characters.map((c) => c.term)).toEqual([
      'Harry Potter',
      'Fleur Delacour',
      'Ron Weasley',
    ])
  })

  it('ranks real relationships ahead of inferred pairings even when the guess weighs more', async () => {
    // A ship the reader actually captured must lead the query budget; a heavier
    // *inferred* pairing only fills the slot after it (net stays wide, rerank decides).
    mockFetchPage.mockReset()
    mockFetchPage.mockImplementation(async (url: string) => {
      const u = new URL(url)
      const term = decodeURIComponent(u.searchParams.get('term') ?? '')
      if (u.pathname.endsWith('/character')) {
        return json({ 'Harry P.': ['Harry Potter'], 'Fleur D.': ['Fleur Delacour'] }[term] ?? [])
      }
      if (term === 'Harry Potter/Fleur Delacour') return json(['Fleur Delacour/Harry Potter'])
      return json([])
    })

    const chars = {
      canonical: [] as { term: string; weight: number }[],
      raw: [
        { term: 'Harry P.', weight: 9 },
        { term: 'Fleur D.', weight: 8 },
      ],
    }
    const raw: Ao3RawSeeds = {
      // a light canonical ship from an AO3 capture …
      relationships: { canonical: [{ term: 'Ginny Weasley/Harry Potter', weight: 1 }], raw: [] },
      // … versus a heavier pairing inferred from the FFN romance-fic character list
      characters: chars,
      fandoms: { canonical: [], raw: [] },
      romanceCharacters: chars,
    }

    const seeds = await resolveAo3Seeds(raw, { delayMs: 0 })
    expect(seeds.relationships).toEqual([
      { term: 'Ginny Weasley/Harry Potter', weight: 1 }, // real, leads despite lower weight
      { term: 'Fleur Delacour/Harry Potter', weight: 8 }, // inferred, fills the slot after
    ])
  })

  it('does not infer a pairing when the co-listed characters are not from a romance fic', async () => {
    // Same characters, but romanceCharacters is empty (they only ever co-occurred in a
    // gen/adventure fic) → no ship is synthesized, even though the characters resolve.
    mockFetchPage.mockReset()
    mockFetchPage.mockImplementation(async (url: string) => {
      const term = decodeURIComponent(new URL(url).searchParams.get('term') ?? '')
      return json({ 'Harry P.': ['Harry Potter'], 'Fleur D.': ['Fleur Delacour'] }[term] ?? [])
    })

    const raw: Ao3RawSeeds = {
      relationships: { canonical: [], raw: [] },
      characters: {
        canonical: [],
        raw: [
          { term: 'Harry P.', weight: 5 },
          { term: 'Fleur D.', weight: 4 },
        ],
      },
      fandoms: { canonical: [], raw: [] },
      romanceCharacters: { canonical: [], raw: [] }, // no romance fic → no pairing signal
    }

    const seeds = await resolveAo3Seeds(raw, { delayMs: 0 })
    expect(seeds.relationships).toEqual([]) // characters resolved, but no ship inferred
    expect(seeds.characters.map((c) => c.term)).toEqual(['Harry Potter', 'Fleur Delacour'])
  })
})
