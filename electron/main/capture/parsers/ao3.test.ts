import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { parseAo3Metadata } from './ao3'

describe('parseAo3Metadata', () => {
  it('extracts title and author from AO3 markup', () => {
    const dom = new JSDOM(`
      <h2 class="title heading">A Study in Fanfic</h2>
      <h3 class="byline heading"><a rel="author" href="/users/foo">Foo Bar</a></h3>
    `)
    expect(parseAo3Metadata(dom)).toEqual({ title: 'A Study in Fanfic', author: 'Foo Bar' })
  })

  it('returns undefined fields when selectors are absent', () => {
    const dom = new JSDOM('<div>nothing here</div>')
    expect(parseAo3Metadata(dom)).toEqual({ title: undefined, author: undefined })
  })
})
