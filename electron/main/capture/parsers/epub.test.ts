import { describe, it, expect, afterAll } from 'vitest'
import { parseEpubMetadata } from './epub'
import { buildEpub, makeEpubFile, writeTempEpub, cleanupTempEpubs, PNG_1x1 } from '../../../../test/fixtures/epub'

afterAll(() => cleanupTempEpubs())

describe('parseEpubMetadata', () => {
  it('extracts title and author from the OPF', () => {
    const path = makeEpubFile({ title: 'The Hobbit', author: 'J.R.R. Tolkien' })
    const meta = parseEpubMetadata(path)
    expect(meta.title).toBe('The Hobbit')
    expect(meta.author).toBe('J.R.R. Tolkien')
  })

  it('resolves the cover via <meta name="cover"> + manifest item', () => {
    const path = makeEpubFile({ cover: { href: 'cover.png', data: PNG_1x1 } })
    const meta = parseEpubMetadata(path)
    expect(meta.coverBuffer).not.toBeNull()
    expect(meta.coverBuffer!.length).toBe(PNG_1x1.length)
    expect(meta.coverExt).toBe('png')
  })

  it('resolves the cover via properties="cover-image"', () => {
    const path = makeEpubFile({ cover: { href: 'img/c.png', data: PNG_1x1, useProperties: true } })
    const meta = parseEpubMetadata(path)
    expect(meta.coverBuffer).not.toBeNull()
    expect(meta.coverExt).toBe('png')
  })

  it('returns null cover when none is declared', () => {
    const meta = parseEpubMetadata(makeEpubFile({ title: 'No Cover' }))
    expect(meta.coverBuffer).toBeNull()
    expect(meta.coverExt).toBeNull()
  })

  it('resolves OPF and content from a nested directory', () => {
    const path = makeEpubFile({ opfDir: 'EPUB/content/', title: 'Nested' })
    expect(parseEpubMetadata(path).title).toBe('Nested')
  })

  it('returns empty metadata (no throw) when container.xml points nowhere', () => {
    const path = writeTempEpub(
      buildEpub({ containerXml: '<container>no rootfile here</container>' }),
    )
    const meta = parseEpubMetadata(path)
    expect(meta).toEqual({ title: null, author: null, coverBuffer: null, coverExt: null })
  })

  it('returns empty metadata for a non-epub / garbage file', () => {
    const path = writeTempEpub(Buffer.from('not a zip'))
    expect(parseEpubMetadata(path)).toEqual({
      title: null,
      author: null,
      coverBuffer: null,
      coverExt: null,
    })
  })

  it('handles a missing title/creator gracefully', () => {
    const path = writeTempEpub(
      buildEpub({
        opfContent:
          '<?xml version="1.0"?><package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"></metadata><manifest/><spine/></package>',
      }),
    )
    const meta = parseEpubMetadata(path)
    expect(meta.title).toBeNull()
    expect(meta.author).toBeNull()
  })
})
