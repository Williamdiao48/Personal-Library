import { describe, it, expect, vi, beforeEach } from 'vitest'

// dedup touches the DB only through db.all (owned-item scan). Mock it so the pure
// key logic + the scan run offline and ABI-free (no better-sqlite3).
vi.mock('../db', () => ({ all: vi.fn(() => []) }))

import { canonicalWorkId, contentKey, norm, findLiveDuplicate } from './dedup'
import { all } from '../db'

const mockAll = vi.mocked(all)

/** Seed the live-item scan with full rows. */
function live(
  ...rows: { id?: string; title?: string; source_url?: string | null; author?: string | null }[]
): void {
  mockAll.mockReturnValue(
    rows.map((r, i) => ({
      id: r.id ?? `item-${i}`,
      title: r.title ?? 'Untitled',
      source_url: r.source_url ?? null,
      author: r.author ?? null,
    })),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAll.mockReturnValue([])
})

describe('canonicalWorkId', () => {
  it('reduces AO3 URL variants (query / chapter / scheme) to one id', () => {
    for (const url of [
      'https://archiveofourown.org/works/123',
      'https://archiveofourown.org/works/123?view_full_work=true',
      'https://archiveofourown.org/works/123/chapters/456',
      'http://archiveofourown.org/works/123',
    ]) {
      expect(canonicalWorkId(url)).toEqual({ kind: 'ao3', id: '123' })
    }
  })

  it('reduces FFN story URLs and rejects non-work / cross-host URLs', () => {
    expect(canonicalWorkId('https://www.fanfiction.net/s/999/1/Slug')).toEqual({
      kind: 'ffn',
      id: '999',
    })
    expect(canonicalWorkId('https://example.com/works/1')).toBeNull()
    expect(canonicalWorkId('not a url')).toBeNull()
  })
})

describe('contentKey / norm', () => {
  it('normalizes case, punctuation, and whitespace to a stable key', () => {
    expect(norm('Oh God, Not Again!')).toBe('oh god not again')
    expect(contentKey('Oh God, Not Again!', 'Sarah1281')).toBe('oh god not again|sarah1281')
    // Same fic, messier formatting → identical key.
    expect(contentKey('  oh   god  not  again  ', 'SARAH1281')).toBe('oh god not again|sarah1281')
  })

  it('returns null unless BOTH title and author are present (precision-first)', () => {
    expect(contentKey('Title', null)).toBeNull()
    expect(contentKey(null, 'Author')).toBeNull()
    expect(contentKey('', 'Author')).toBeNull()
    expect(contentKey('Title', '   ')).toBeNull()
  })
})

describe('findLiveDuplicate', () => {
  it('matches a same-site work across URL variants (canonical id)', () => {
    live({
      id: 'owned',
      title: 'Owned',
      source_url: 'https://archiveofourown.org/works/1/chapters/9',
    })
    // Incoming is the bare work URL — same canonical id.
    expect(findLiveDuplicate('https://archiveofourown.org/works/1', 'Owned', null)).toEqual({
      id: 'owned',
      title: 'Owned',
    })
  })

  it('matches the SAME fic cross-posted to the other site by normalized title+author', () => {
    // Owned from AO3; the identical fic is now being captured from FFN (different site
    // id, so canonical can't match) — the normalized title|author must catch it.
    live({
      id: 'ao3-copy',
      title: 'Oh God, Not Again!',
      source_url: 'https://archiveofourown.org/works/4701869',
      author: 'Sarah1281',
    })
    const dup = findLiveDuplicate(
      'https://www.fanfiction.net/s/4536005/1/Oh-God-Not-Again',
      'oh god not again',
      'SARAH1281',
    )
    expect(dup).toEqual({ id: 'ao3-copy', title: 'Oh God, Not Again!' })
  })

  it('does not match a different fic that merely shares a title (author differs)', () => {
    live({ id: 'a', title: 'Common Title', source_url: null, author: 'Author One' })
    expect(
      findLiveDuplicate('https://www.fanfiction.net/s/1/1/x', 'Common Title', 'Author Two'),
    ).toBeNull()
  })

  it('does not content-match when either side lacks an author (precision-first)', () => {
    live({ id: 'a', title: 'Solo', source_url: null, author: null })
    expect(findLiveDuplicate('https://www.fanfiction.net/s/1/1/x', 'Solo', 'Writer')).toBeNull()
    live({ id: 'a', title: 'Solo', source_url: null, author: 'Writer' })
    expect(findLiveDuplicate('https://www.fanfiction.net/s/1/1/x', 'Solo', null)).toBeNull()
  })

  it('content-matches an owned item that has no fanfic source_url (e.g. an EPUB)', () => {
    live({ id: 'epub', title: 'Imported As Epub', source_url: null, author: 'Writer' })
    expect(
      findLiveDuplicate('https://www.fanfiction.net/s/9/1/z', 'imported as epub', 'writer'),
    ).toEqual({
      id: 'epub',
      title: 'Imported As Epub',
    })
  })

  it('excludes deleted items via the deleted_at IS NULL query', () => {
    findLiveDuplicate('https://archiveofourown.org/works/1', 'X', 'Y')
    expect(mockAll).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'))
  })

  it('returns null when there is nothing to match on (no canonical id, no author)', () => {
    live({ id: 'a', title: 'Something', source_url: null, author: 'Writer' })
    // A generic URL (no work id) + a title with no author → no key on either axis.
    expect(findLiveDuplicate('https://example.com/page', 'Something', null)).toBeNull()
    expect(mockAll).not.toHaveBeenCalled() // short-circuits before the scan
  })
})
