import { describe, it, expect, afterAll } from 'vitest'
import { extractEpub } from './epub'
import {
  makeEpubFile,
  writeTempEpub,
  cleanupTempEpubs,
  PNG_1x1,
} from '../../../../test/fixtures/epub'

afterAll(() => cleanupTempEpubs())

describe('extractEpub (shared extractor)', () => {
  it('returns metadata + plain text + word count for a normal EPUB', () => {
    const path = makeEpubFile({
      title: 'The Hobbit',
      author: 'J.R.R. Tolkien',
      chapters: [
        { href: 'c1.xhtml', title: 'Ch 1', body: '<p>In a hole in the ground.</p>' },
        { href: 'c2.xhtml', title: 'Ch 2', body: '<p>There lived a hobbit.</p>' },
      ],
    })
    const r = extractEpub(path)
    expect(r.title).toBe('The Hobbit')
    expect(r.author).toBe('J.R.R. Tolkien')
    // Chapter bodies are flattened to plain text and concatenated.
    expect(r.plainText).toContain('In a hole in the ground.')
    expect(r.plainText).toContain('There lived a hobbit.')
    expect(r.plainText).not.toMatch(/<[^>]+>/) // tags stripped
    expect(r.wordCount).toBe(10)
    // word count is derived from the flattened plain text
    expect(r.wordCount).toBe(r.plainText.split(/\s+/).filter(Boolean).length)
  })

  it('carries the cover buffer + extension through', () => {
    const path = makeEpubFile({ cover: { href: 'cover.png', data: PNG_1x1 } })
    const r = extractEpub(path)
    expect(r.coverBuffer).not.toBeNull()
    expect(r.coverBuffer!.length).toBe(PNG_1x1.length)
    expect(r.coverExt).toBe('png')
  })

  it('is best-effort: garbage bytes yield empty metadata, empty text, null word count (no throw)', () => {
    const path = writeTempEpub(Buffer.from('not a zip at all'))
    const r = extractEpub(path)
    expect(r).toEqual({
      title: null,
      author: null,
      coverBuffer: null,
      coverExt: null,
      plainText: '',
      wordCount: null,
    })
  })
})
