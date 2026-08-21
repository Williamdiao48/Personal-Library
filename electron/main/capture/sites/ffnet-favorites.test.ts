import { describe, it, expect, vi, beforeEach } from 'vitest'

// discoverFfnetFavorites couples only to fetch.ts (a single fetchPage that rides
// the CF browser fallback). Mock it and feed FFN-shaped profile HTML so the parse
// runs offline. parseFfnetFavorites itself is pure and tested directly.
vi.mock('../fetch', () => ({ fetchPage: vi.fn() }))

import { parseFfnetFavorites, discoverFfnetFavorites } from './ffnet-favorites'
import { fetchPage } from '../fetch'

const mockFetch = vi.mocked(fetchPage)

// Real FFN markup writes class attrs SINGLE-QUOTED and UNQUOTED (`class='z-list
// favstories'`, `class=stitle`) and packs the row data into data-* attributes —
// the fixtures mirror that exactly (the spike's key gotcha).
function favRow(opts: {
  id?: string
  title?: string
  slug?: string
  author?: string | null
  fandom?: string | null
  words?: string | null
  chapters?: string | null
  withStitle?: boolean // false → no a.stitle (URL must fall back to the data id)
}): string {
  const {
    id = '111',
    title = 'A Story',
    slug = 'A-Story',
    author = 'Author',
    fandom = 'Harry Potter',
    words = '50,000',
    chapters = '20',
    withStitle = true,
  } = opts
  const data = [
    `data-storyid=${id}`,
    `data-title='${title}'`,
    fandom != null ? `data-category='${fandom}'` : '',
    words != null ? `data-wordcount=${words.replace(/,/g, '')}` : '',
    chapters != null ? `data-chapters=${chapters}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return `<div class='z-list favstories' ${data}>
    ${withStitle ? `<a class=stitle href='/s/${id}/1/${slug}'>${title}</a>` : ''}
    ${author != null ? `<a href='/u/9/${author}'>${author}</a>` : ''}
  </div>`
}

function profile(rows: string[]): string {
  // #fs is the tab pane holding the .favstories SOURCE divs. #fs_inside is the
  // JS-drawn visible copy; the spike confirmed those copies do NOT carry the
  // `favstories` class (27 rows → 27, not 54), so they never enter the parse.
  return `<html><body>
    <div id='content_wrapper_inner'>
      <div id='fs'>${rows.join('')}</div>
      <div id='fs_inside'><div class='z-list mystories'>visible copy — no favstories class</div></div>
    </div>
  </body></html>`
}

describe('parseFfnetFavorites', () => {
  it('extracts every favorite via data-* attributes with a canonical URL', () => {
    const html = `<div id='fs'>${favRow({
      id: '111',
      title: 'The Tale',
      slug: 'The-Tale',
      author: 'Tacioli',
      fandom: 'Naruto',
      words: '123,456',
      chapters: '42',
    })}</div>`
    const works = parseFfnetFavorites(html)
    expect(works).toEqual([
      {
        url: 'https://www.fanfiction.net/s/111/1/The-Tale',
        title: 'The Tale',
        author: 'Tacioli',
        fandom: 'Naruto',
        words: 123456,
        chapters: 42,
      },
    ])
  })

  it('parses exactly the source rows — the JS-drawn #fs_inside copy is not counted', () => {
    const works = parseFfnetFavorites(
      profile([
        favRow({ id: '1', title: 'One' }),
        favRow({ id: '2', title: 'Two' }),
        favRow({ id: '3', title: 'Three' }),
      ]),
    )
    expect(works.map((w) => w.url.match(/\/s\/(\d+)/)?.[1])).toEqual(['1', '2', '3'])
  })

  it('falls back to a bare /s/{id} URL when the title anchor is missing', () => {
    const works = parseFfnetFavorites(
      `<div id='fs'>${favRow({ id: '77', withStitle: false })}</div>`,
    )
    expect(works[0].url).toBe('https://www.fanfiction.net/s/77')
  })

  it('yields null author/fandom and null counts when those fields are absent', () => {
    const works = parseFfnetFavorites(
      `<div id='fs'>${favRow({ id: '5', author: null, fandom: null, words: null, chapters: null })}</div>`,
    )
    expect(works[0]).toMatchObject({ author: null, fandom: null, words: null, chapters: null })
  })

  it('returns an empty array for a profile with no favorites', () => {
    expect(parseFfnetFavorites('<html><body><div id="fs"></div></body></html>')).toEqual([])
  })
})

describe('discoverFfnetFavorites', () => {
  beforeEach(() => mockFetch.mockReset())

  it('fetches the profile URL and parses its favorites', async () => {
    mockFetch.mockResolvedValue(`<div id='fs'>${favRow({ id: '42', title: 'Answer' })}</div>`)
    const works = await discoverFfnetFavorites('12345')
    expect(mockFetch).toHaveBeenCalledWith('https://www.fanfiction.net/u/12345/')
    expect(works).toHaveLength(1)
    expect(works[0].title).toBe('Answer')
  })
})
