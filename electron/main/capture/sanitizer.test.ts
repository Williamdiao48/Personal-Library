import { describe, it, expect } from 'vitest'
import { sanitize } from './sanitizer'

// The article sanitizer: tight allow-list, http/https only (no data:), no
// class/id (CSS-clickjacking defence), img forced to loading="lazy".

describe('sanitize (article HTML)', () => {
  it('drops <script> and its contents', () => {
    const out = sanitize('<p>ok</p><script>alert(1)</script>')
    expect(out).toContain('<p>ok</p>')
    expect(out).not.toMatch(/script/i)
    expect(out).not.toContain('alert(1)')
  })

  it('drops <style>, <iframe>, <form>, <video>, <svg>', () => {
    for (const tag of ['style', 'iframe', 'form', 'video', 'svg']) {
      const out = sanitize(`<${tag}>x</${tag}><p>keep</p>`)
      expect(out).toContain('keep')
      expect(out.toLowerCase()).not.toContain(`<${tag}`)
    }
  })

  it('strips event handlers like onerror/onclick', () => {
    const out = sanitize('<img src="https://e.com/a.png" onerror="alert(1)">')
    expect(out).not.toMatch(/onerror/i)
  })

  it('strips class and id (clickjacking defence)', () => {
    const out = sanitize('<div class="epub-settings-overlay" id="x">t</div>')
    expect(out).toContain('t')
    expect(out).not.toMatch(/class=/i)
    expect(out).not.toMatch(/\bid=/i)
  })

  it('removes javascript: and data: URLs (http/https only)', () => {
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).not.toMatch(/href/i)
    expect(sanitize('<a href="data:text/html,x">x</a>')).not.toMatch(/href/i)
    expect(sanitize('<img src="data:image/png;base64,AAAA">')).not.toMatch(/src=/i)
  })

  it('keeps http/https links', () => {
    const out = sanitize('<a href="https://example.com/x" title="t">x</a>')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('title="t"')
  })

  it('forces loading="lazy" on images', () => {
    const out = sanitize('<img src="https://e.com/a.png" alt="a">')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('alt="a"')
  })

  it('preserves colspan/rowspan on table cells', () => {
    const out = sanitize('<table><tr><td colspan="2" rowspan="3">c</td></tr></table>')
    expect(out).toContain('colspan="2"')
    expect(out).toContain('rowspan="3"')
  })

  it('keeps core prose tags', () => {
    const out = sanitize('<h2>T</h2><p><strong>a</strong> <em>b</em></p><blockquote>q</blockquote>')
    expect(out).toContain('<h2>T</h2>')
    expect(out).toContain('<strong>a</strong>')
    expect(out).toContain('<em>b</em>')
    expect(out).toContain('<blockquote>q</blockquote>')
  })
})
