import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { JSDOM } from 'jsdom'
import { transformChapterHtml, type ChapterContext } from './epub-content'

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
