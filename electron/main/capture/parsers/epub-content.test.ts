import { describe, it, expect, afterAll } from 'vitest'
import AdmZip from 'adm-zip'
import { JSDOM } from 'jsdom'
import {
  transformChapterHtml,
  extractEpubContent,
  extractEpubPlainText,
  realignSkewedToc,
  type ChapterContext,
  type EpubChapter,
  type EpubTocEntry,
} from './epub-content'
import { makeEpubFile, writeTempEpub, cleanupTempEpubs } from '../../../../test/fixtures/epub'

// F9: the per-chapter rewrite now happens on a parsed DOM (no regex over raw
// markup), with sanitize-html as the final step. These fixtures exercise the
// malformed / hostile inputs called out in the audit — nested/unclosed tags,
// onerror variants, data:text/html in odd casings — plus the link/image/title
// rewriting behaviour, asserting nothing unsafe survives to the renderer.

// 1×1 transparent PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** Build an AdmZip and round-trip through a buffer so entry headers are populated. */
function zipWith(files: Record<string, Buffer>): AdmZip {
  const z = new AdmZip()
  for (const [name, buf] of Object.entries(files)) z.addFile(name, buf)
  return new AdmZip(z.toBuffer())
}

function ctx(over: Partial<ChapterContext> = {}): ChapterContext {
  return { xhtmlDir: '', zip: new AdmZip(), spineHrefToIndex: new Map(), bookTitle: '', ...over }
}

/** Re-parse rewritten output the way the renderer will, to assert on structure. */
function parse(html: string): Document {
  return new JSDOM(html).window.document
}

describe('transformChapterHtml (F9 DOM rewriting)', () => {
  // ── sanitizer is never bypassed by malformed markup ──
  it('drops <script> and its contents', () => {
    const out = transformChapterHtml('<p>hi</p><script>alert(1)</script>', ctx())
    expect(out).not.toMatch(/script/i)
    expect(out).not.toContain('alert(1)')
  })

  it('strips onerror off a malformed unquoted <img> and removes its non-data src', () => {
    const out = transformChapterHtml('<img src=x onerror=alert(1)>', ctx())
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toMatch(/\bsrc=/i) // x is non-data and unresolved → removed
  })

  it('removes a data:text/html src regardless of casing', () => {
    const out = transformChapterHtml('<img src="DATA:text/html,<b>x</b>">', ctx())
    expect(out.toLowerCase()).not.toContain('data:text/html')
    expect(parse(out).querySelector('img')?.getAttribute('src') ?? null).toBeNull()
  })

  it('keeps a safe data:image src', () => {
    const uri = 'data:image/png;base64,AAAA'
    const out = transformChapterHtml(`<img src="${uri}" alt="a">`, ctx())
    expect(out).toContain(uri)
  })

  // ── image inlining from the zip ──
  it('inlines a relative <img> as a base64 data URI', () => {
    const out = transformChapterHtml(
      '<img src="images/p.png">',
      ctx({
        xhtmlDir: 'text/',
        zip: zipWith({ 'text/images/p.png': PNG_1x1 }),
      }),
    )
    expect(out).toMatch(/src="data:image\/png;base64,/)
  })

  it('strips src for a missing image entry', () => {
    const out = transformChapterHtml('<img src="images/missing.png">', ctx({ xhtmlDir: 'text/' }))
    expect(out).not.toMatch(/\bsrc=/i)
  })

  // ── SVG <image> cover pages (Calibre pattern) ──
  it('unwraps an SVG <image> cover into an inlined <img>, dropping the <svg>', () => {
    // The standard Calibre cover page: a raster wrapped in an SVG viewport,
    // referenced via xlink:href. sanitize-html strips <svg>/<image>, so without
    // the unwrap this whole page renders blank.
    const out = transformChapterHtml(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 800">' +
        '<image width="600" height="800" xlink:href="cover.png"/></svg>',
      ctx({ xhtmlDir: 'text/', zip: zipWith({ 'text/cover.png': PNG_1x1 }) }),
    )
    const doc = parse(out)
    const img = doc.querySelector('img')
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    // Tagged so the renderer gives it full-page (not inline-illustration) sizing.
    expect(img?.hasAttribute('data-epub-cover')).toBe(true)
    expect(doc.querySelector('svg')).toBeNull()
    expect(doc.querySelector('image')).toBeNull()
  })

  it('handles an SVG <image> using a plain href (SVG2)', () => {
    const out = transformChapterHtml(
      '<svg viewBox="0 0 1 1"><image href="cover.png"/></svg>',
      ctx({ xhtmlDir: 'text/', zip: zipWith({ 'text/cover.png': PNG_1x1 }) }),
    )
    expect(parse(out).querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  })

  it('emits no broken src when an SVG <image> reference is unresolvable', () => {
    const out = transformChapterHtml(
      '<svg><image xlink:href="missing.png"/></svg>',
      ctx({ xhtmlDir: 'text/' }),
    )
    expect(out).not.toMatch(/\bsrc=/i)
    expect(out).not.toContain('missing.png')
  })

  it('marks and hoists a plain <img> cover wrapped in <p> out of its wrapper', () => {
    // The other common cover style (e.g. Last Smile in Sunder City): a plain
    // <img> inside <p class="cover">. Nested in the auto-height <p>, a percentage
    // max-height wouldn't constrain it, so it must be hoisted to a direct child.
    const out = transformChapterHtml(
      '<p class="cover"><img src="images/c.png"/></p>',
      ctx({ xhtmlDir: 'text/', zip: zipWith({ 'text/images/c.png': PNG_1x1 }) }),
    )
    const doc = parse(out)
    const img = doc.querySelector('img')
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(img?.hasAttribute('data-epub-cover')).toBe(true)
    expect(img?.parentElement?.tagName).toBe('BODY') // hoisted out of the <p>
    expect(doc.querySelector('p')).toBeNull()
  })

  it('does not mark an inline image on a page that also has text', () => {
    const out = transformChapterHtml(
      '<p>Some prose.</p><img src="images/c.png"/>',
      ctx({ xhtmlDir: 'text/', zip: zipWith({ 'text/images/c.png': PNG_1x1 }) }),
    )
    expect(out).not.toContain('data-epub-cover')
    expect(out).toContain('Some prose.')
  })

  // ── internal link rewriting ──
  it('rewrites a cross-chapter link to data-epub-chapter + fragment, dropping href', () => {
    const out = transformChapterHtml(
      '<a href="ch2.xhtml#sec">next</a>',
      ctx({
        xhtmlDir: 'text/',
        spineHrefToIndex: new Map([['text/ch2.xhtml', 3]]),
      }),
    )
    expect(out).toContain('data-epub-chapter="3"')
    expect(out).toContain('data-epub-fragment="sec"')
    expect(out).not.toMatch(/href=/i)
  })

  it('rewrites a same-chapter fragment link', () => {
    const out = transformChapterHtml('<a href="#note1">n</a>', ctx())
    expect(out).toContain('data-epub-fragment="note1"')
    expect(out).not.toMatch(/href=/i)
  })

  it('keeps external http(s) links unchanged', () => {
    const out = transformChapterHtml('<a href="https://example.com/x">e</a>', ctx())
    expect(out).toContain('href="https://example.com/x"')
  })

  it('strips a spoofed pre-existing data-epub-chapter and uses the resolved index', () => {
    const out = transformChapterHtml(
      '<a href="ch2.xhtml" data-epub-chapter="999">x</a>',
      ctx({
        xhtmlDir: 'text/',
        spineHrefToIndex: new Map([['text/ch2.xhtml', 1]]),
      }),
    )
    expect(out).toContain('data-epub-chapter="1"')
    expect(out).not.toContain('999')
  })

  it('cannot smuggle a live <img>/onerror through a crafted fragment value', () => {
    // Fragment decodes to: a"><img src=x onerror=alert(1)>
    const out = transformChapterHtml(
      '<a href="#a&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">x</a>',
      ctx(),
    )
    const d = parse(out)
    expect(d.querySelector('img')).toBeNull() // stays inert inside the attribute value
    const hasOnerror = Array.from(d.querySelectorAll('*')).some((el) =>
      el.getAttributeNames().includes('onerror'),
    )
    expect(hasOnerror).toBe(false)
  })

  // ── leading running-header title stripping (now pre-sanitize) ──
  it('strips a leading heading that is exactly the book title', () => {
    const out = transformChapterHtml(
      '<h1>My Book</h1><p>Real text.</p>',
      ctx({ bookTitle: 'My Book' }),
    )
    expect(out).not.toMatch(/my book/i)
    expect(out).toContain('Real text.')
  })

  it('keeps a leading heading that is not the book title', () => {
    const out = transformChapterHtml(
      '<h1>Chapter One</h1><p>Body.</p>',
      ctx({ bookTitle: 'My Book' }),
    )
    expect(out).toContain('Chapter One')
  })

  it('matches the title through HTML entities (&amp;)', () => {
    const out = transformChapterHtml(
      '<p>Cats &amp; Dogs</p><p>Body.</p>',
      ctx({ bookTitle: 'Cats & Dogs' }),
    )
    expect(out).not.toMatch(/cats/i)
    expect(out).toContain('Body.')
  })

  // ── robustness / clickjacking ──
  it('handles nested/unclosed tags without error', () => {
    const out = transformChapterHtml('<p><b>bold<i>both</p>', ctx())
    expect(out).toContain('bold')
    expect(out).toContain('both')
  })

  it('strips class and id (CSS-clickjacking defence)', () => {
    const out = transformChapterHtml('<div class="epub-settings-overlay" id="x">t</div>', ctx())
    expect(out).not.toMatch(/class=/i)
    expect(out).not.toMatch(/\bid=/i)
  })
})

describe('transformChapterHtml — redundant container flattening', () => {
  // WHY: side padding is applied to `.epub-page-content > *` (direct children).
  // A chapter wrapped in one container is a single direct child spanning every
  // column, so multicolumn's default box-decoration-break paints its horizontal
  // padding on only the first/last column and interior pages render flush to the
  // edges. Flattening pure wrappers makes each real block a direct child.

  const bodyChildTags = (out: string): string[] =>
    Array.from(parse(out).body.children).map((el) => el.tagName)

  it('hoists a single wrapper <div> so paragraphs become top-level', () => {
    const out = transformChapterHtml('<div><p>a</p><p>b</p></div>', ctx())
    expect(out).not.toMatch(/<div/i)
    expect(bodyChildTags(out)).toEqual(['P', 'P'])
  })

  it('flattens nested pure wrappers to the leaf block', () => {
    const out = transformChapterHtml('<section><div><p>a</p></div></section>', ctx())
    expect(out).not.toMatch(/<div|<section/i)
    expect(bodyChildTags(out)).toEqual(['P'])
  })

  it('flattens a multi-<section> book into top-level paragraphs', () => {
    const out = transformChapterHtml(
      '<section><p>a</p></section><section><p>b</p></section>',
      ctx(),
    )
    expect(out).not.toMatch(/<section/i)
    expect(bodyChildTags(out)).toEqual(['P', 'P'])
  })

  it('keeps a <div> that holds its own text (div-as-paragraph leaf)', () => {
    // Such a div is a paragraph unit, not a layout wrapper — kept so the
    // renderer's baseline CSS can give it paragraph spacing.
    const out = transformChapterHtml('<div>hello</div><div>world</div>', ctx())
    expect(bodyChildTags(out)).toEqual(['DIV', 'DIV'])
    expect(parse(out).body.textContent).toBe('helloworld')
  })

  it('unwraps a pure wrapper but preserves a div-paragraph nested inside it', () => {
    const out = transformChapterHtml('<div><div>line one</div><p>line two</p></div>', ctx())
    // Outer wrapper (no direct text) is removed; the inner text-bearing div stays.
    expect(bodyChildTags(out)).toEqual(['DIV', 'P'])
    expect(parse(out).body.querySelector('div')?.textContent).toBe('line one')
  })

  it('does not flatten meaningful block containers (blockquote, pre, lists)', () => {
    const out = transformChapterHtml('<blockquote><p>q</p></blockquote><pre>code</pre>', ctx())
    expect(bodyChildTags(out)).toEqual(['BLOCKQUOTE', 'PRE'])
  })

  it('leaves already-flat content unchanged', () => {
    const out = transformChapterHtml('<p>a</p><p>b</p>', ctx())
    expect(bodyChildTags(out)).toEqual(['P', 'P'])
  })

  it('still resolves a full-page cover wrapped in a <div> to a bare cover <img>', () => {
    const out = transformChapterHtml(
      '<div><img src="images/c.png"/></div>',
      ctx({ xhtmlDir: 'text/', zip: zipWith({ 'text/images/c.png': PNG_1x1 }) }),
    )
    const doc = parse(out)
    const img = doc.querySelector('img')
    expect(img?.hasAttribute('data-epub-cover')).toBe(true)
    expect(img?.parentElement?.tagName).toBe('BODY')
    expect(doc.querySelector('div')).toBeNull()
  })

  it('strips a book-title running header buried inside a wrapper', () => {
    // Flattening runs before title stripping, so a title inside a wrapper is now
    // reachable as a leading node.
    const out = transformChapterHtml(
      '<div><h1>My Book</h1><p>Real text.</p></div>',
      ctx({ bookTitle: 'My Book' }),
    )
    expect(out).not.toMatch(/my book/i)
    expect(out).toContain('Real text.')
  })

  it('keeps a div that wraps only inline content as its own block', () => {
    // A chapter-number `<div><b>7</b></div>` must stay a block, not dissolve into
    // an inline run — it holds no block child, so it is a paragraph-like leaf.
    const out = transformChapterHtml('<div><b>7</b></div><div>Body.</div>', ctx())
    expect(bodyChildTags(out)).toEqual(['DIV', 'DIV'])
    expect(parse(out).body.firstElementChild?.querySelector('b')?.textContent).toBe('7')
  })
})

describe('transformChapterHtml — phantom layout anchors', () => {
  const bodyChildTags = (out: string): string[] =>
    Array.from(parse(out).body.children).map((el) => el.tagName)

  it('unwraps a self-closing chapter anchor that the HTML parser wraps around the body', () => {
    // `<a id="c1"/>` is not valid HTML self-close: the parser leaves <a> open and
    // reconstructs it around the following blocks. Every paragraph ends up inside
    // one spanning <a> — the exact "flush to the edges" cause in real Penguin EPUBs.
    const out = transformChapterHtml('<p><a id="c1"/></p><div>One.</div><div>Two.</div>', ctx())
    // No anchor should wrap block content.
    expect(/<a[^>]*>\s*<div/i.test(out)).toBe(false)
    expect(parse(out).body.querySelectorAll('div').length).toBe(2)
  })

  it('leaves a real (href-bearing) link that wraps a block intact', () => {
    const out = transformChapterHtml('<a href="https://example.com"><div>card</div></a>', ctx())
    const a = parse(out).querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com')
    expect(a?.querySelector('div')?.textContent).toBe('card')
  })

  it('leaves an href-less anchor around inline content alone', () => {
    const out = transformChapterHtml('<p>see <a id="n1">note</a> here</p>', ctx())
    expect(parse(out).querySelector('a')?.textContent).toBe('note')
  })

  it('after unwrapping, block paragraphs become top-level and keep their text', () => {
    const out = transformChapterHtml('<p><a id="c1"/></p><div>Alpha.</div><div>Beta.</div>', ctx())
    const divs = Array.from(parse(out).body.querySelectorAll('div'))
    expect(divs.map((d) => d.textContent)).toEqual(['Alpha.', 'Beta.'])
    expect(bodyChildTags(out)).toContain('DIV')
  })
})

describe('transformChapterHtml — blockquote-as-paragraph normalization', () => {
  const many = (n: number, cls = 'calibre15') =>
    Array.from({ length: n }, (_, i) => `<blockquote class="${cls}">Para ${i}.</blockquote>`).join(
      '',
    )

  it('retags Calibre blockquote-paragraphs to plain blocks (no quote styling)', () => {
    const out = transformChapterHtml(`<div class="calibre1">${many(8)}</div>`, ctx())
    expect(out).not.toMatch(/<blockquote/i)
    expect(parse(out).body.querySelectorAll('div').length).toBe(8)
  })

  it('retags when blockquotes dominate even without a Calibre marker', () => {
    const out = transformChapterHtml(many(7, 'x'), ctx())
    expect(out).not.toMatch(/<blockquote/i)
  })

  it('collapses a nested blockquote heading to a single block, preserving text', () => {
    const out = transformChapterHtml(
      `<blockquote class="calibre5"><blockquote class="calibre6"><span>Twenty-six</span></blockquote></blockquote>${many(5)}`,
      ctx(),
    )
    expect(out).not.toMatch(/<blockquote/i)
    expect(parse(out).body.textContent).toContain('Twenty-six')
  })

  it('leaves a genuine, occasional blockquote quote styled as a quote', () => {
    // One quote amid many paragraphs → not dominant, no marker → untouched.
    const paras = Array.from({ length: 10 }, (_, i) => `<p>Body ${i}.</p>`).join('')
    const out = transformChapterHtml(`${paras}<blockquote>An actual quotation.</blockquote>`, ctx())
    expect(out).toMatch(/<blockquote/i)
    expect(out).toContain('An actual quotation.')
  })
})

describe('extractEpubContent — front/back matter classification', () => {
  afterAll(() => cleanupTempEpubs())

  const flags = (opts: Parameters<typeof makeEpubFile>[0]) =>
    extractEpubContent(makeEpubFile(opts)).chapters.map((c) => c.frontMatter)

  it('flags front/back matter by title and leaves body chapters unflagged', () => {
    const opts = {
      chapters: [
        { href: 'a.xhtml', title: 'Cover', body: '<p>x</p>' },
        { href: 'b.xhtml', title: 'Title Page', body: '<p>x</p>' },
        { href: 'c.xhtml', title: 'Introduction', body: '<p>x</p>' },
        { href: 'd.xhtml', title: 'Chapter 1', body: '<p>x</p>' },
        { href: 'e.xhtml', title: 'Chapter 2', body: '<p>x</p>' },
        { href: 'f.xhtml', title: 'Epilogue', body: '<p>x</p>' },
        { href: 'g.xhtml', title: 'About the Author', body: '<p>x</p>' },
      ],
    }
    expect(flags(opts)).toEqual([true, true, true, false, false, true, true])
  })

  it('treats Prologue/Epilogue/Introduction/Appendix as standalone (unnumbered)', () => {
    const opts = {
      chapters: [
        { href: 'a.xhtml', title: 'Prologue', body: '<p>x</p>' },
        { href: 'b.xhtml', title: 'The Long Road', body: '<p>x</p>' },
        { href: 'c.xhtml', title: 'Appendix B', body: '<p>x</p>' },
      ],
    }
    // Prologue + Appendix are matter (unnumbered); the middle title is a body chapter.
    expect(flags(opts)).toEqual([true, false, true])
  })

  it('does not flag a real chapter that merely starts like matter (Notes from…)', () => {
    const opts = {
      chapters: [
        { href: 'a.xhtml', title: 'Notes from Underground', body: '<p>x</p>' },
        { href: 'b.xhtml', title: 'The Index Case', body: '<p>x</p>' },
      ],
    }
    expect(flags(opts)).toEqual([false, false])
  })

  it('flags untitled front matter before the EPUB2 <guide> start-of-reading', () => {
    // Neither title matches the heuristic; the guide marks story.xhtml as body,
    // so the earlier spine entry is front matter purely by structure.
    const opts = {
      chapters: [
        { href: 'plate.xhtml', title: 'Frontispiece Plate', body: '<p>x</p>' },
        { href: 'story.xhtml', title: 'The Beginning', body: '<p>x</p>' },
      ],
      guide: { textHref: 'story.xhtml' },
    }
    expect(flags(opts)).toEqual([true, false])
  })

  it('flags front matter before the EPUB3 bodymatter landmark', () => {
    const opts = {
      chapters: [
        { href: 'fm.xhtml', title: 'Some Publisher Blurb', body: '<p>x</p>' },
        { href: 'ch1.xhtml', title: 'The Beginning', body: '<p>x</p>' },
        { href: 'ch2.xhtml', title: 'The Middle', body: '<p>x</p>' },
      ],
      landmarks: { bodymatterHref: 'ch1.xhtml' },
    }
    expect(flags(opts)).toEqual([true, false, false])
  })
})

describe('extractEpubContent — TOC (logical chapter list)', () => {
  afterAll(() => cleanupTempEpubs())

  const toc = (opts: Parameters<typeof makeEpubFile>[0]) =>
    extractEpubContent(makeEpubFile(opts)).toc.map((e) => [e.title, e.chapterIndex, e.frontMatter])

  it('is empty when the EPUB has no nav/ncx (reader falls back to the spine list)', () => {
    const book = extractEpubContent(
      makeEpubFile({ chapters: [{ href: 'c1.xhtml', title: 'Chapter 1', body: '<p>x</p>' }] }),
    )
    expect(book.toc).toEqual([])
  })

  it('marks a TOC entry equal to the book title, and a "Map of …" entry, as front matter', () => {
    const opts = {
      title: 'Eagle Strike',
      chapters: [
        { href: 't.xhtml', title: 'x', body: '<p>title page</p>' }, // idx 0
        { href: 'm.xhtml', title: 'x', body: '<p>map</p>' }, // idx 1
        { href: 'c1.xhtml', title: 'x', body: '<p>a</p>' }, // idx 2
      ],
      navToc: [
        { label: 'Eagle Strike', href: 't.xhtml' }, // == book title → matter
        { label: 'Map of Cornwall', href: 'm.xhtml' }, // "Map of …" → matter
        { label: 'The Gift', href: 'c1.xhtml' }, // real chapter
      ],
    }
    expect(toc(opts)).toEqual([
      ['Eagle Strike', 0, true],
      ['Map of Cornwall', 1, true],
      ['The Gift', 2, false],
    ])
  })

  it('builds the chapter list from toc.ncx, not the spine — the Calibre-split case', () => {
    // Mirrors "Fire in the Sky": every spine file shares the book <title>, and
    // real chapters live only in the NCX, landing on every other split file.
    const split = (n: number) => ({
      href: `s${n}.html`,
      title: 'Fire in the Sky', // identical running title on every fragment
      body: `<p>fragment ${n}</p>`,
    })
    const opts = {
      title: 'Fire in the Sky',
      chapters: [
        { href: 'titlepage.xhtml', title: 'Cover', body: '<p>c</p>' }, // idx 0
        split(0), // idx 1 — front fragment, not in the TOC
        split(1), // idx 2 — Maps
        split(2), // idx 3 — Chapter One
        split(3), // idx 4 — Ch1 continuation, not in the TOC
        split(4), // idx 5 — Chapter Two
      ],
      ncx: [
        { label: 'Maps', href: 's1.html#filepos1' },
        { label: 'Chapter One', href: 's2.html#filepos2' },
        { label: 'Chapter Two', href: 's4.html#filepos3' },
      ],
    }
    // The TOC lists real chapters (no repeated "Fire in the Sky"); Maps is
    // unnumbered matter, the two chapters number 1, 2; indices point at the
    // right spine files.
    expect(toc(opts)).toEqual([
      ['Maps', 2, true],
      ['Chapter One', 3, false],
      ['Chapter Two', 5, false],
    ])
    // The spine itself is untouched — still one entry per physical file.
    expect(extractEpubContent(makeEpubFile(opts)).chapters).toHaveLength(6)
  })

  it('builds the chapter list from an EPUB3 nav toc', () => {
    const opts = {
      chapters: [
        { href: 'cover.xhtml', title: 'Cover', body: '<p>c</p>' }, // idx 0
        { href: 'ch1.xhtml', title: 'x', body: '<p>a</p>' }, // idx 1
        { href: 'ch2.xhtml', title: 'x', body: '<p>b</p>' }, // idx 2
      ],
      navToc: [
        { label: 'Cover', href: 'cover.xhtml' },
        { label: 'The Start', href: 'ch1.xhtml' },
        { label: 'The Middle', href: 'ch2.xhtml' },
      ],
    }
    expect(toc(opts)).toEqual([
      ['Cover', 0, true],
      ['The Start', 1, false],
      ['The Middle', 2, false],
    ])
  })

  it('drops TOC entries that point outside the spine', () => {
    const opts = {
      chapters: [{ href: 'ch1.xhtml', title: 'x', body: '<p>a</p>' }],
      ncx: [
        { label: 'Real', href: 'ch1.xhtml' },
        { label: 'Dangling', href: 'nope.xhtml' },
      ],
    }
    expect(toc(opts)).toEqual([['Real', 0, false]])
  })
})

describe('realignSkewedToc (malformed one-early TOC repair)', () => {
  const chap = (text: string): EpubChapter => ({
    title: '',
    html: `<p>${text}</p>`,
    frontMatter: false,
  })
  const entry = (title: string, chapterIndex: number, frontMatter = false): EpubTocEntry => ({
    title,
    chapterIndex,
    frontMatter,
  })

  it('realigns a uniformly one-early skewed TOC (and drops the orphaned last entry)', () => {
    // content: idx0 Maps, idx1 CHAPTER ONE, idx2 CHAPTER TWO, idx3 CHAPTER THREE
    const chapters = [
      chap('Maps'),
      chap('CHAPTER ONE Lusa'),
      chap('CHAPTER TWO Kallik'),
      chap('CHAPTER THREE Toklo'),
    ]
    // every link points one entry early
    const toc = [
      entry('Chapter One', 0),
      entry('Chapter Two', 1),
      entry('Chapter Three', 2),
      entry('About the Author', 3, true),
    ]
    expect(realignSkewedToc(toc, chapters).map((e) => [e.title, e.chapterIndex])).toEqual([
      ['Chapter One', 1],
      ['Chapter Two', 2],
      ['Chapter Three', 3],
    ])
  })

  it('is a strict no-op when chapter labels match their own target (correct TOC)', () => {
    const chapters = [chap('CHAPTER ONE'), chap('CHAPTER TWO'), chap('CHAPTER THREE')]
    const toc = [entry('Chapter One', 0), entry('Chapter Two', 1), entry('Chapter Three', 2)]
    expect(realignSkewedToc(toc, chapters)).toBe(toc) // same reference — untouched
  })

  it('is a no-op when labels are not ordinal chapters (nothing to validate against)', () => {
    const chapters = [chap('The Shire'), chap('Rivendell'), chap('Moria')]
    const toc = [entry('The Shire', 1), entry('Rivendell', 2), entry('Moria', 0)]
    expect(realignSkewedToc(toc, chapters)).toBe(toc)
  })

  it('end-to-end: extractEpubContent repairs a Calibre-style one-early NCX', () => {
    const opts = {
      title: 'Fire in the Sky',
      chapters: [
        { href: 'contents.html', title: 'x', body: '<p>Contents</p>' }, // idx0
        { href: 'maps.html', title: 'x', body: '<p>Maps</p>' }, // idx1
        { href: 'c1.html', title: 'x', body: '<p>CHAPTER ONE Lusa</p>' }, // idx2
        { href: 'c2.html', title: 'x', body: '<p>CHAPTER TWO Kallik</p>' }, // idx3
        { href: 'c3.html', title: 'x', body: '<p>CHAPTER THREE Toklo</p>' }, // idx4
      ],
      ncx: [
        { label: 'Maps', href: 'contents.html' }, // skewed →idx0
        { label: 'Chapter One', href: 'maps.html' }, // →idx1
        { label: 'Chapter Two', href: 'c1.html' }, // →idx2
        { label: 'Chapter Three', href: 'c2.html' }, // →idx3
        { label: 'Acknowledgments', href: 'c3.html' }, // →idx4
      ],
    }
    expect(
      extractEpubContent(makeEpubFile(opts)).toc.map((e) => [e.title, e.chapterIndex]),
    ).toEqual([
      ['Maps', 1], // maps.html
      ['Chapter One', 2], // c1.html (CHAPTER ONE)
      ['Chapter Two', 3], // c2.html
      ['Chapter Three', 4], // c3.html (CHAPTER THREE)
    ])
  })
})

describe('extractEpubPlainText (import / FTS text-only path)', () => {
  afterAll(() => cleanupTempEpubs())

  it('concatenates chapter body text in spine order, tags stripped', () => {
    const path = makeEpubFile({
      chapters: [
        { href: 'c1.xhtml', title: 'Ch 1', body: '<p>In a hole in the ground.</p>' },
        { href: 'c2.xhtml', title: 'Ch 2', body: '<p>There lived a hobbit.</p>' },
      ],
    })
    const text = extractEpubPlainText(path)
    expect(text).toBe('In a hole in the ground. There lived a hobbit.')
    expect(text).not.toMatch(/<[^>]+>/)
  })

  it('keeps inline-element text (a tag boundary becomes a space, as before)', () => {
    // Behaviour-preserving quirk: replacing each tag with a space means an inline
    // element flush against punctuation leaves a space (…hobbit</em>. → "hobbit .").
    // The prior render-then-strip path produced the identical text.
    const path = makeEpubFile({
      chapters: [{ href: 'c1.xhtml', title: 'Ch', body: '<p>a <em>hobbit</em>.</p>' }],
    })
    expect(extractEpubPlainText(path)).toBe('a hobbit .')
  })

  it('excludes <head> (e.g. <title>), <script>, and <style> contents', () => {
    // makeEpubFile wraps body in <head><title>…</title></head>; add inline
    // script/style inside the body to prove their text never reaches the index.
    const path = makeEpubFile({
      chapters: [
        {
          href: 'c1.xhtml',
          title: 'SECRETHEADWORD',
          body: '<style>.x{color:SECRETCSSWORD}</style><p>Visible prose.</p><script>var SECRETJSWORD=1</script>',
        },
      ],
    })
    const text = extractEpubPlainText(path)
    expect(text).toBe('Visible prose.')
    expect(text).not.toContain('SECRETHEADWORD') // head <title> excluded
    expect(text).not.toContain('SECRETCSSWORD') // <style> contents excluded
    expect(text).not.toContain('SECRETJSWORD') // <script> contents excluded
  })

  it('decodes HTML entities', () => {
    const path = makeEpubFile({
      chapters: [{ href: 'c1.xhtml', title: 'Ch', body: '<p>Salt &amp; pepper &#38; more</p>' }],
    })
    expect(extractEpubPlainText(path)).toBe('Salt & pepper & more')
  })

  it('throws on a non-EPUB file (caller treats it as empty text)', () => {
    const path = writeTempEpub(Buffer.from('not a zip at all'))
    expect(() => extractEpubPlainText(path)).toThrow()
  })
})
