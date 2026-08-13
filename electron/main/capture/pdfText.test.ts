import { describe, it, expect } from 'vitest'
import { extractPdfText } from './pdfText'

// Exercises the REAL bundled pdfjs-dist (no mock) so the pdf-parse → pdfjs swap
// (audit LEAN-1) is locked against regressions. pdfjs-dist is pure JS, so this
// needs no better-sqlite3 ABI toggle.

// Build a tiny valid single-page PDF whose content stream draws `text`. Enough
// for pdfjs to recover a text layer; xref offsets are real so no recovery path
// is needed.
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

// Build a valid N-page PDF, each page drawing its own `pageTexts[i]`. Used to
// prove per-page cleanup (page.cleanup() after each getTextContent) doesn't drop
// or reorder content across a multi-page document.
function makeMultiPagePdf(pageTexts: string[]): Uint8Array {
  // Object layout: 1 Catalog, 2 Pages, then per page a Page obj + a Contents obj,
  // and a single shared Font as the final object.
  const n = pageTexts.length
  const fontObjNum = 3 + n * 2 // pages occupy objs 3..3+2n-1; font is last
  const kids: string[] = []
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''] // obj 2 filled below
  for (let i = 0; i < n; i++) {
    const pageObjNum = 3 + i * 2
    const contentObjNum = pageObjNum + 1
    kids.push(`${pageObjNum} 0 R`)
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents ${contentObjNum} 0 R ` +
        `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`,
    )
    const stream = `BT /F1 18 Tf 20 100 Td (${pageTexts[i]}) Tj ET`
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n'
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

describe('extractPdfText (real pdfjs-dist)', () => {
  it('extracts the text layer from a valid PDF', async () => {
    const text = await extractPdfText(makePdf('Hello World from PDF'))
    expect(text).toContain('Hello World from PDF')
  })

  it('concatenates text from every page in order (per-page cleanup keeps content)', async () => {
    const text = await extractPdfText(
      makeMultiPagePdf(['Page one alpha', 'Page two beta', 'Page three gamma']),
    )
    expect(text).toContain('Page one alpha')
    expect(text).toContain('Page two beta')
    expect(text).toContain('Page three gamma')
    // Order preserved across the cleanup-per-page loop.
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
    expect(text.indexOf('beta')).toBeLessThan(text.indexOf('gamma'))
  })

  it('throws on a non-PDF buffer (callers treat it as non-fatal)', async () => {
    await expect(extractPdfText(new Uint8Array(Buffer.from('not a pdf at all')))).rejects.toThrow()
  })
})
