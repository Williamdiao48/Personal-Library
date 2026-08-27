import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { okJson, notOk, type FakeResponse } from '../../../test/stubs/httpResponse'
import { openTestDb, closeTestDb, type TestDb } from '../../../test/db/harness'
import {
  normalizeOpenLibraryDoc,
  looksNonEnglishTitle,
  looksNonEnglishDescription,
  looksLikeFiction,
  contentTokens,
  coverUrlFromId,
  fetchCandidates,
  extractOlDescription,
  cleanOlDescription,
  CANDIDATES,
  type OpenLibraryDoc,
  type CandidatesConfig,
} from './candidates'
import type { SeedQuery } from './seedQueries'

// The normalizer is pure; fetchCandidates touches candidate_cache (openTestDb,
// Node ABI) and the global fetch (stubbed).

const doc = (over: Partial<OpenLibraryDoc> = {}): OpenLibraryDoc => ({
  key: '/works/OL1W',
  title: 'A Book',
  author_name: ['An Author'],
  subject: ['Fantasy'],
  cover_i: 42,
  isbn: ['9780000000001'],
  ...over,
})

const query = (q: string, over: Partial<SeedQuery> = {}): SeedQuery => ({
  kind: 'subject',
  term: q,
  q,
  weight: 1,
  ...over,
})

describe('coverUrlFromId', () => {
  it('builds a cover URL from a numeric id', () => {
    expect(coverUrlFromId(42)).toBe('https://covers.openlibrary.org/b/id/42-M.jpg')
  })
  it('returns null when there is no cover id', () => {
    expect(coverUrlFromId(undefined)).toBeNull()
  })
})

describe('looksNonEnglishTitle', () => {
  it('flags a title with ≥2 distinct Romance/German function words', () => {
    expect(looksNonEnglishTitle('Una corte de niebla y furia')).toBe(true)
    expect(looksNonEnglishTitle('El amor en los tiempos')).toBe(true)
    expect(looksNonEnglishTitle('Die Verwandlung und der Prozess')).toBe(true)
    // Only DISTINCT hits count — a repeated single article is one hit, not two.
    expect(looksNonEnglishTitle('Der Herr der Ringe')).toBe(false)
  })
  it('keeps a real English title with at most one stray foreign article', () => {
    expect(looksNonEnglishTitle('La La Land')).toBe(false)
    expect(looksNonEnglishTitle('El Deafo')).toBe(false)
    expect(looksNonEnglishTitle('A Court of Mist and Fury')).toBe(false)
    expect(looksNonEnglishTitle('The Count of Monte Cristo')).toBe(false)
  })
})

describe('looksNonEnglishDescription', () => {
  it('flags a fully-German blurb (≥3 distinct function words)', () => {
    expect(
      looksNonEnglishDescription(
        'Die junge Elfe reist mit dem Drachen und der Prinzessin durch die Welt von Alagaesia.',
      ),
    ).toBe(true)
  })
  it('flags a non-Latin-script blurb', () => {
    expect(looksNonEnglishDescription('魔法学校の物語です。')).toBe(true)
  })
  it('keeps an English blurb even with one or two stray foreign words', () => {
    expect(
      looksNonEnglishDescription('A sweeping tale of a young mage set in the land of El Dorado.'),
    ).toBe(false) // "el" alone = 1 distinct
    expect(looksNonEnglishDescription('The making of the film "La Dolce Vita" and its era.')).toBe(
      false,
    ) // "la" only
  })
  it('is false for an absent/empty description (no signal)', () => {
    expect(looksNonEnglishDescription(null)).toBe(false)
    expect(looksNonEnglishDescription(undefined)).toBe(false)
    expect(looksNonEnglishDescription('')).toBe(false)
  })
})

describe('looksLikeFiction', () => {
  it('accepts a book with a "… fiction" subject or a narrative genre', () => {
    expect(looksLikeFiction('Some Novel', ['Fantasy fiction', 'Wizards'])).toBe(true)
    expect(looksLikeFiction('Some Novel', ['Science fiction'])).toBe(true)
    expect(looksLikeFiction('Some Novel', ['Dragons', 'Knights'])).toBe(true) // genre, no "fiction"
    expect(looksLikeFiction('Some Novel', ['Juvenile fiction', 'Adventure'])).toBe(true)
  })
  it('rejects nonfiction on an arbitrary topic (no fiction marker)', () => {
    // The reported leaks: a seed-science textbook and a topic manual carry no fiction tag.
    expect(
      looksLikeFiction('Principles of Seed Science and Technology', ['Seeds', 'Agriculture']),
    ).toBe(false)
    expect(looksLikeFiction('A Manual', ['Technology', 'Handbooks'])).toBe(false)
    expect(looksLikeFiction('Untitled', [])).toBe(false) // no subjects → no positive signal
  })
  it('does NOT count "nonfiction" as a fiction marker (word boundary)', () => {
    expect(looksLikeFiction('A Book', ['Juvenile nonfiction'])).toBe(false)
  })
  it('rejects a film/TV companion even when it carries a genre word', () => {
    // "The Book of Alien" (making-of): "Science fiction films" trips the genre regex, but a
    // book ABOUT a film is nonfiction — the film-form guard wins.
    expect(
      looksLikeFiction('The Book of Alien', ['Science fiction films', 'Motion pictures']),
    ).toBe(false)
    expect(looksLikeFiction('Alien', ['Alien (Motion picture)'])).toBe(false)
  })
})

describe('normalizeOpenLibraryDoc', () => {
  it('maps a full doc to a Candidate', () => {
    expect(normalizeOpenLibraryDoc(doc())).toEqual({
      title: 'A Book',
      author: 'An Author',
      subjects: ['Fantasy'],
      coverUrl: 'https://covers.openlibrary.org/b/id/42-M.jpg',
      sourceId: '/works/OL1W',
      isbn: '9780000000001',
      description: null, // search.json has no blurb — books stay metadata-only
      source: 'book',
    })
  })

  it('drops a doc with no usable title', () => {
    expect(normalizeOpenLibraryDoc(doc({ title: '   ' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: undefined }))).toBeNull()
  })

  it('drops OpenLibrary placeholder/stub titles', () => {
    expect(normalizeOpenLibraryDoc(doc({ title: 'Untitled Sanderson 3 of 3' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'Unknown title' }))).toBeNull()
    // A real title merely containing one of these as a substring is safe (word boundary).
    expect(normalizeOpenLibraryDoc(doc({ title: 'The Untitledness of Being' }))).not.toBeNull()
  })

  it('tolerates every optional field being absent', () => {
    const c = normalizeOpenLibraryDoc({ title: 'Bare' })
    expect(c).toMatchObject({
      title: 'Bare',
      author: null,
      subjects: [],
      coverUrl: null,
      isbn: null,
      description: null,
    })
  })

  it('caps subjects and trims/drops blanks', () => {
    const many = Array.from({ length: CANDIDATES.MAX_SUBJECTS_PER_DOC + 5 }, (_, i) => `s${i}`)
    const c = normalizeOpenLibraryDoc(doc({ subject: ['  Fantasy  ', '', ...many] }))!
    expect(c.subjects).toHaveLength(CANDIDATES.MAX_SUBJECTS_PER_DOC)
    expect(c.subjects[0]).toBe('Fantasy') // trimmed, blank dropped
  })

  it('takes the first author and first isbn', () => {
    const c = normalizeOpenLibraryDoc(
      doc({ author_name: ['First', 'Second'], isbn: ['i1', 'i2'] }),
    )!
    expect(c.author).toBe('First')
    expect(c.isbn).toBe('i1')
  })

  it('synthesizes a sourceId when the work key is missing', () => {
    const c = normalizeOpenLibraryDoc(
      doc({ key: undefined, title: 'Dune', author_name: ['Herbert'] }),
    )!
    expect(c.sourceId).toBe('synthetic:dune|herbert')
  })

  it('rejects graphic novels / comics / manga by subject (text-first reader)', () => {
    for (const s of [
      'Comics & graphic novels',
      'Graphic novels',
      'Comic books, strips, etc.',
      'Manga',
      'Cartoons and comics',
    ]) {
      expect(normalizeOpenLibraryDoc(doc({ subject: ['Fantasy', s] }))).toBeNull()
    }
  })

  it('rejects a graphic-novel tag even when it appears past the subjects cap', () => {
    const pad = Array.from({ length: CANDIDATES.MAX_SUBJECTS_PER_DOC + 2 }, (_, i) => `s${i}`)
    expect(normalizeOpenLibraryDoc(doc({ subject: [...pad, 'Graphic novels'] }))).toBeNull()
  })

  it('rejects a graphic novel that self-identifies ONLY in the title (no comic subject tag)', () => {
    // Wings-of-Fire adaptation "The hidden kingdom [graphic novel]" — its real subjects
    // carry NO comic/graphic tag, so the title is the only signal (leaked 2026-08-26).
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'The hidden kingdom [graphic novel]',
          subject: ['Children’s fiction', 'Dragons, fiction', 'Fantasy fiction'],
          number_of_pages_median: 312,
        }),
      ),
    ).toBeNull()
  })

  it('keeps a normal novel whose subjects merely mention adjacent words', () => {
    // "Comics" adjacent to nothing graphic-novel-ish stays (targeted, not aggressive).
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ['Science fiction', 'Adventure'] })),
    ).not.toBeNull()
  })

  it('rejects non-readable franchise merchandise by title (poster/coloring/collector/etc.)', () => {
    for (const title of [
      'Harry Potter Poster Book',
      'Harry Potter: The Poster Collection',
      'The Official Harry Potter Coloring Book',
      'Harry Potter Colouring Book',
      'Star Wars Sticker Book',
      'The LEGO Activity Book',
      'Harry Potter Postcard Book',
      'The Art of Frozen Sketchbook',
      "The Harry Potter Collector's Handbook",
      'Harry Potter Collectors Handbook',
      "A Collector's Guide to Star Wars Figures",
      'Funko Pop Price Guide',
    ]) {
      expect(normalizeOpenLibraryDoc(doc({ title }))).toBeNull()
    }
  })

  it('rejects merchandise by subject even past the subjects cap', () => {
    const pad = Array.from({ length: CANDIDATES.MAX_SUBJECTS_PER_DOC + 2 }, (_, i) => `s${i}`)
    expect(normalizeOpenLibraryDoc(doc({ subject: [...pad, 'Coloring books'] }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ subject: ['Poster books'] }))).toBeNull()
  })

  it('rejects young-children reading formats (picture / board / nursery / easy readers)', () => {
    // "Teddy Bear, Teddy Bear" leaked as a nursery-rhyme book — tagged by subject.
    expect(
      normalizeOpenLibraryDoc(
        doc({ title: 'Teddy Bear, Teddy Bear', subject: ['Nursery rhymes'] }),
      ),
    ).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'A Board Book of Colors' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ subject: ['Board books'] }))).toBeNull()
    // "Lost in Little Bear's Room" (Minarik) — its real OpenLibrary subjects.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: "Lost in Little Bear's Room",
          subject: ['Animals', 'Picture books', 'Bears', 'Juvenile Easy Readers'],
        }),
      ),
    ).toBeNull()
    // Other markers seen across the series.
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ['Juvenile Fiction / Readers / Beginner'] })),
    ).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ subject: ['Readers - Beginner'] }))).toBeNull()
  })

  it('keeps a real middle-grade / YA novel (juvenile reject is format-targeted, not blanket)', () => {
    // NOT a blanket "juvenile"/"children's" reject — real MG/YA novels (Harry Potter et al.)
    // carry these tags and must stay.
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ['Juvenile fiction', 'Fantasy'] })),
    ).not.toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ["Children's fiction", 'Wizards', 'Fiction'] })),
    ).not.toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ["Children's stories", 'Adventure'] })),
    ).not.toBeNull()
  })

  it('keeps a real novel whose title merely mentions an adjacent word', () => {
    // Targeted phrases (format word + "book"/"collection"), not a bare "poster"/"sticker",
    // so these stay.
    for (const title of [
      'The Poster', // no "book"/"collection"
      'A Collection of Short Stories',
      'The Activity of Being', // "activity" without "book"
      'Sticker: A Novel',
    ]) {
      expect(normalizeOpenLibraryDoc(doc({ title }))).not.toBeNull()
    }
  })

  it('rejects companion / franchise guide merchandise by title (cinematic guide, film companion, etc.)', () => {
    // "Harry Potter: Albus Dumbledore Cinematic Guide" bled into normal recs on 2026-08-26.
    for (const title of [
      'Harry Potter: Albus Dumbledore Cinematic Guide',
      'The Hobbit: An Unexpected Journey Movie Guide',
      'The Lord of the Rings Film Companion',
      'Harry Potter: A Visual Companion',
      'The Unofficial Guide to Hogwarts',
      'The Official Guide to the Wizarding World',
    ]) {
      expect(normalizeOpenLibraryDoc(doc({ title }))).toBeNull()
    }
  })

  it('rejects non-fiction commentary / reference / technical works (content-type gate)', () => {
    // Books ABOUT a franchise/topic, dragged in by broad subject seeds — markers from real
    // fetched OpenLibrary metadata (2026-08-26).
    // "Looking for God in Harry Potter" — literary/religious criticism.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Looking for God in Harry Potter',
          subject: ['Harry Potter', 'History and criticism', 'Religion in literature'],
        }),
      ),
    ).toBeNull()
    // "We Love Harry Potter!" — fandom miscellanea / handbook.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'We Love Harry Potter!',
          subject: ['Harry Potter', 'Handbooks, manuals, etc.'],
        }),
      ),
    ).toBeNull()
    // "Bears" seed stems to "Bearings (Machinery)" → engineering manuals.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Ball and Roller Bearings: Theory, Design and Application',
          subject: ['Bearings (Machinery)', 'Mechanical engineering'],
        }),
      ),
    ).toBeNull()
    // Other content-type markers.
    for (const s of [
      'Criticism and interpretation',
      'Encyclopedias',
      'Concordances',
      'Study guides',
    ]) {
      expect(normalizeOpenLibraryDoc(doc({ subject: ['Fantasy', s] }))).toBeNull()
    }
  })

  it('keeps a real HP novel (content-type gate targets commentary markers, not the franchise)', () => {
    // The reader's genuine novels carry "Fantasy fiction"/"Wizards" (+ OL's messy
    // "English literature"/"Literary theory" edition-merge tags) but NONE of the
    // commentary/handbook/technical markers, so they must survive.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: "Harry Potter and the Philosopher's Stone",
          subject: ['Fantasy fiction', 'Wizards', 'Magic', 'English literature', 'Literary theory'],
        }),
      ),
    ).not.toBeNull()
    // A real novel set in a wilderness — "Bears" as a genuine subject must NOT be caught by
    // the bearing/machinery markers.
    expect(
      normalizeOpenLibraryDoc(
        doc({ subject: ['Bears', 'Adventure fiction', 'Wilderness survival'] }),
      ),
    ).not.toBeNull()
  })

  it('rejects sub-substantive lengths by median page count (picture / early-reader books)', () => {
    // "Big Brown Bear" (24 pp) is subject-for-subject the SAME as the owned Seekers novels
    // — only the page count separates a children's book from an MG novel on the same topic.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Big Brown Bear',
          subject: ["Children's fiction", 'Bears, fiction'],
          number_of_pages_median: 24,
        }),
      ),
    ).toBeNull()
    // "The big brown bear" (48 pp, "Bears"/"Juvenile fiction") — the length gate, not the
    // subjects (which we deliberately keep for real MG/YA), is what catches it.
    expect(
      normalizeOpenLibraryDoc(
        doc({ subject: ['Bears', 'Juvenile fiction', 'Fiction'], number_of_pages_median: 48 }),
      ),
    ).toBeNull()
    // Boundary: below the threshold rejected, at/above it kept.
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ['Fantasy'], number_of_pages_median: 64 })),
    ).toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ subject: ['Fantasy'], number_of_pages_median: 65 })),
    ).not.toBeNull()
  })

  it('catches a null-page-count picture book via the "Stories in rhyme" marker', () => {
    // "Big brown bear =" has NO page count for the length gate — the subject marker gets it.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Big brown bear =',
          subject: ['Bears', 'Stories in rhyme', 'Juvenile fiction'],
        }),
      ),
    ).toBeNull()
  })

  it('keeps full-length MG/YA animal novels (Seekers, Warriors) — the length gate has huge margin', () => {
    // The owned series and the adjacent series exploration SHOULD reach: both are 295–336 pp,
    // far above the picture-book cut, sharing the "Bears/Cats + Juvenile fiction" subjects that
    // no keyword could separate from the picture books.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'The Quest Begins',
          subject: ['Bears', 'Fantasy fiction', 'Juvenile Fiction', "Children's fiction"],
          number_of_pages_median: 320,
        }),
      ),
    ).not.toBeNull()
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Into the Wild',
          subject: [
            'Cats',
            'Fantasy fiction',
            'Juvenile Fiction',
            'Adventure and adventurers, fiction',
          ],
          number_of_pages_median: 295,
        }),
      ),
    ).not.toBeNull()
    // A book with no page count at all falls through the length gate (present-only).
    expect(normalizeOpenLibraryDoc(doc({ subject: ['Fantasy'] }))).not.toBeNull()
  })

  it('rejects non-English editions but keeps English or language-absent docs', () => {
    // The "Polish book" leak — a language list present and lacking `eng`.
    expect(normalizeOpenLibraryDoc(doc({ language: ['pol'] }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ language: ['fre', 'ger'] }))).toBeNull()
    // A multilingual work that HAS an English edition is kept.
    expect(normalizeOpenLibraryDoc(doc({ language: ['spa', 'eng', 'ita'] }))).not.toBeNull()
    // A missing/empty language list is kept (OpenLibrary omits it freely).
    expect(normalizeOpenLibraryDoc(doc({ language: [] }))).not.toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ language: undefined }))).not.toBeNull()
  })

  it('rejects foreign-TITLED works even when an English edition exists (the language field passes them)', () => {
    // A translated work OpenLibrary lists under its original-language canonical title (the
    // Witcher's "Wieża jaskółki") HAS an English edition, so the language gate keeps it —
    // the title's non-English diacritics / non-Latin script are the only signal.
    expect(
      normalizeOpenLibraryDoc(doc({ title: 'Wieża jaskółki', language: ['pol', 'eng'] })),
    ).toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ title: 'Война и мир', language: ['rus', 'eng'] })),
    ).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: '三体' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'Ἀνάβασις' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'Die Verwandlung mit ß' }))).toBeNull()
    // English titles and accented loanwords / names are KEPT (high precision, not recall).
    expect(normalizeOpenLibraryDoc(doc({ title: 'Café Society' }))).not.toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'Les Misérables' }))).not.toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'Nineteen Eighty-Four' }))).not.toBeNull()
  })

  it('rejects a pure-ASCII foreign title by function words (≥2 Romance/German articles)', () => {
    // "Una corte de niebla y furia" (the Spanish edition of A Court of Mist and Fury) has an
    // English edition and no diacritics, so only the function words tell — una/de/y.
    expect(normalizeOpenLibraryDoc(doc({ title: 'Una corte de niebla y furia' }))).toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'La sombra del viento' }))).toBeNull()
    // A lone foreign article in a real English title is kept (needs ≥2 distinct hits).
    expect(normalizeOpenLibraryDoc(doc({ title: 'La La Land' }))).not.toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'El Deafo' }))).not.toBeNull()
    expect(normalizeOpenLibraryDoc(doc({ title: 'A Court of Mist and Fury' }))).not.toBeNull()
  })

  it('rejects the picture/activity-book profile (juvenile audience, no length, no genre)', () => {
    // "Acorns everywhere!" / "The Berenstain Bears grow-it": Bears + Juvenile fiction, no
    // page count, no genre subject — leaked into explore. Only the young FORMAT tags missed
    // them; the audience+no-length+no-genre combination catches them.
    expect(
      normalizeOpenLibraryDoc(
        doc({
          title: 'Acorns everywhere!',
          subject: ['Bears', 'Juvenile fiction', 'Squirrels', 'Fiction'],
          number_of_pages_median: undefined,
        }),
      ),
    ).toBeNull()
    // Saved by a substantive page count (a real MG novel: Seekers 320, Warriors 295).
    expect(
      normalizeOpenLibraryDoc(
        doc({
          subject: ['Bears', 'Juvenile fiction', "Children's fiction"],
          number_of_pages_median: 320,
        }),
      ),
    ).not.toBeNull()
    // Saved by a fiction-genre subject even with no page count (Harry Potter / Seekers carry Fantasy).
    expect(
      normalizeOpenLibraryDoc(
        doc({
          subject: ['Juvenile fiction', 'Fantasy', 'Dragons'],
          number_of_pages_median: undefined,
        }),
      ),
    ).not.toBeNull()
    // A book with NO juvenile-audience subject is untouched by this gate.
    expect(
      normalizeOpenLibraryDoc(
        doc({ subject: ['Ducks', 'Friendship'], number_of_pages_median: undefined }),
      ),
    ).not.toBeNull()
  })

  it('rejects the zero-footprint obscurity long tail (≤1 edition, 0 readers, 0 ratings)', () => {
    // Where the genuinely strange self-published items live (e.g. an imagined-war one-off).
    expect(
      normalizeOpenLibraryDoc(doc({ edition_count: 1, readinglog_count: 0, ratings_count: 0 })),
    ).toBeNull()
    // Any footprint saves it: a handful of readers, OR ratings, OR multiple editions.
    expect(
      normalizeOpenLibraryDoc(doc({ edition_count: 1, readinglog_count: 5, ratings_count: 0 })),
    ).not.toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ edition_count: 8, readinglog_count: 0, ratings_count: 0 })),
    ).not.toBeNull()
    expect(
      normalizeOpenLibraryDoc(doc({ edition_count: 1, readinglog_count: 0, ratings_count: 3 })),
    ).not.toBeNull()
    // No footprint fields at all (fixtures / OL omission) ⇒ NOT rejected (guarded on signal).
    expect(normalizeOpenLibraryDoc(doc())).not.toBeNull()
  })

  it('carries readinglog_count onto the Candidate as `popularity` (present only)', () => {
    expect(normalizeOpenLibraryDoc(doc({ readinglog_count: 1200 }))!.popularity).toBe(1200)
    // Absent ⇒ no popularity key (prior stays off for that book).
    expect(normalizeOpenLibraryDoc(doc())).not.toHaveProperty('popularity')
  })
})

describe('contentTokens', () => {
  it('strips file-format noise + stopwords from a filename-style title', () => {
    expect(contentTokens('_OceanofPDF.com_Elantris_-_Brandon_Sanderson')).toEqual([
      'elantris',
      'brandon',
      'sanderson',
    ])
  })

  it('keeps real title words and lowercases', () => {
    expect(contentTokens('The Final Empire')).toEqual(['final', 'empire'])
  })
})

describe('extractOlDescription', () => {
  it('reads a plain-string description', () => {
    expect(extractOlDescription({ description: 'A lonely lighthouse keeper.' })).toBe(
      'A lonely lighthouse keeper.',
    )
  })
  it('reads a { type, value } description', () => {
    expect(
      extractOlDescription({ description: { type: '/type/text', value: 'Rival chefs collide.' } }),
    ).toBe('Rival chefs collide.')
  })
  it('returns null when the work carries no description', () => {
    expect(extractOlDescription({})).toBeNull()
    expect(extractOlDescription(null)).toBeNull()
    expect(extractOlDescription({ description: { type: '/type/text' } })).toBeNull()
  })
})

describe('cleanOlDescription', () => {
  it('strips the trailing source-attribution block and collapses whitespace', () => {
    const raw = 'A sweeping saga.\r\n\r\n----------\r\n\r\n[1]: https://en.wikipedia.org/wiki/Book'
    expect(cleanOlDescription(raw)).toBe('A sweeping saga.')
  })
  it('drops leftover markdown link-definition lines', () => {
    expect(cleanOlDescription('Line one.\n[source]: http://example.com/x')).toBe('Line one.')
  })
  it('returns null for empty / whitespace-only / missing input', () => {
    expect(cleanOlDescription('   ')).toBeNull()
    expect(cleanOlDescription(null)).toBeNull()
    expect(cleanOlDescription(undefined)).toBeNull()
  })
})

describe('fetchCandidates', () => {
  let db: TestDb
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = openTestDb()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    closeTestDb()
  })

  // The N+1 means a refresh now issues BOTH search.json calls and per-work
  // `/works/<key>.json` calls, so we route the stubbed fetch by URL: search calls
  // are served from a queue (in query order, as before), works calls by work key.
  function stubFetch(searchQueue: FakeResponse[], works: (key: string) => FakeResponse): void {
    const queue = [...searchQueue]
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url)
      if (u.includes('/search.json')) return queue.shift() ?? okJson({ docs: [] })
      const m = u.match(/(\/works\/[^.]+)\.json/)
      return works(m ? m[1] : '/works/?')
    })
  }

  const noDescriptions = (): FakeResponse => notOk(404)
  const searchCalls = (): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes('/search.json'))
  const worksCalls = (key: string): unknown[] =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes(`${key}.json`))

  it('normalizes, dedups by sourceId across queries, and drops title-less docs', async () => {
    stubFetch(
      [
        okJson({ docs: [doc({ key: '/works/A' }), doc({ title: undefined })] }),
        okJson({ docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' })] }),
      ],
      noDescriptions,
    )
    const out = await fetchCandidates([query('subject:"X"'), query('subject:"Y"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A', '/works/B'])
  })

  it('caps the merged set at MAX_CANDIDATES', async () => {
    const cfg: CandidatesConfig = { ...CANDIDATES, MAX_CANDIDATES: 2 }
    stubFetch(
      [
        okJson({
          docs: [doc({ key: '/works/A' }), doc({ key: '/works/B' }), doc({ key: '/works/C' })],
        }),
      ],
      noDescriptions,
    )
    const out = await fetchCandidates([query('subject:"X"')], { cfg })
    expect(out).toHaveLength(2)
  })

  it('soft-fails a non-2xx query without sinking the batch', async () => {
    stubFetch([notOk(500), okJson({ docs: [doc({ key: '/works/B' })] })], noDescriptions)
    const out = await fetchCandidates([query('subject:"bad"'), query('subject:"good"')])
    expect(out.map((c) => c.sourceId)).toEqual(['/works/B'])
  })

  it('serves a search cache hit without re-fetching', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], noDescriptions)
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    const out = await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(searchCalls()).toHaveLength(1)
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A'])
  })

  it('re-fetches search once the cache entry is older than the TTL', async () => {
    stubFetch(
      [okJson({ docs: [doc({ key: '/works/A' })] }), okJson({ docs: [doc({ key: '/works/A' })] })],
      noDescriptions,
    )
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    await fetchCandidates([query('subject:"X"')], { now: now + CANDIDATES.CACHE_TTL_MS + 1 })
    expect(searchCalls()).toHaveLength(2)
  })

  it('a Refresh (soft-floor cfg) re-fetches search the default TTL would still serve', async () => {
    // Aged past the 2 h soft floor but inside the 7 d hard TTL: normal read serves
    // cache; a fresh Refresh (soft-floor cfg) re-queries. Description TTL is untouched.
    stubFetch(
      [okJson({ docs: [doc({ key: '/works/A' })] }), okJson({ docs: [doc({ key: '/works/A' })] })],
      noDescriptions,
    )
    const now = 1_000_000
    await fetchCandidates([query('subject:"X"')], { now })
    const aged = now + CANDIDATES.SOFT_FLOOR_MS + 1

    await fetchCandidates([query('subject:"X"')], { now: aged }) // default TTL → cache hit
    expect(searchCalls()).toHaveLength(1)

    await fetchCandidates([query('subject:"X"')], {
      now: aged,
      cfg: { ...CANDIDATES, CACHE_TTL_MS: CANDIDATES.SOFT_FLOOR_MS },
    })
    expect(searchCalls()).toHaveLength(2) // re-queried
  })

  it('pages deeper: page 2 sends page=2 and caches separately from page 1', async () => {
    stubFetch(
      [okJson({ docs: [doc({ key: '/works/A' })] }), okJson({ docs: [doc({ key: '/works/B' })] })],
      noDescriptions,
    )
    const now = 1_000_000
    const p1 = await fetchCandidates([query('subject:"X"')], { now })
    const p2 = await fetchCandidates([query('subject:"X"')], { now, page: 2 })
    // A different page is a distinct cache key → a genuine miss, so both hit the
    // network (page 2 is NOT served from the page-1 cache — that was the dead-end bug).
    expect(searchCalls()).toHaveLength(2)
    const urls = searchCalls().map((call) => String((call as unknown[])[0]))
    expect(urls[0]).not.toContain('page=') // page 1 omits the param
    expect(urls[1]).toContain('page=2')
    expect(urls[0]).toContain('sort=readinglog') // grounded by readership at the source
    expect(urls[0]).toContain('language=eng') // server-side gate on foreign-only works
    expect(p1.map((c) => c.sourceId)).toEqual(['/works/A'])
    expect(p2.map((c) => c.sourceId)).toEqual(['/works/B'])
  })

  // ── book descriptions (the OpenLibrary N+1) ───────────────────────────────────

  it('enriches each book candidate with its work description and caches it per-work', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], (key) =>
      key === '/works/A' ? okJson({ description: 'A haunted lighthouse.' }) : notOk(404),
    )
    const now = 2_000_000
    const out = await fetchCandidates([query('subject:"X"')], { now })
    expect(out[0].description).toBe('A haunted lighthouse.')

    // Second refresh: the description is served from the oldesc: cache (no re-fetch).
    await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(worksCalls('/works/A')).toHaveLength(1)
    const row = db
      .prepare(`SELECT query_key FROM candidate_cache WHERE query_key = 'oldesc:/works/A'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('caches a null description so a blurb-less work is not re-fetched', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], () => okJson({})) // work has no blurb
    const now = 3_000_000
    const out = await fetchCandidates([query('subject:"X"')], { now })
    expect(out[0].description).toBeNull()
    await fetchCandidates([query('subject:"X"')], { now: now + 1000 })
    expect(worksCalls('/works/A')).toHaveLength(1)
  })

  it('degrades to a null description when the work fetch fails, keeping the candidate', async () => {
    stubFetch([okJson({ docs: [doc({ key: '/works/A' })] })], () => notOk(500))
    const out = await fetchCandidates([query('subject:"X"')], { now: 4_000_000 })
    expect(out.map((c) => c.sourceId)).toEqual(['/works/A'])
    expect(out[0].description).toBeNull()
  })

  it('skips the works fetch for a synthetic (keyless) candidate', async () => {
    stubFetch(
      [okJson({ docs: [doc({ key: undefined, title: 'Bare', author_name: ['X'] })] })],
      () => okJson({ description: 'should never be fetched' }),
    )
    const out = await fetchCandidates([query('subject:"X"')], { now: 5_000_000 })
    expect(out[0].sourceId).toBe('synthetic:bare|x')
    expect(out[0].description).toBeNull()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/works/'))).toHaveLength(0)
  })
})
