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

describe('extractPdfText (real pdfjs-dist)', () => {
  it('extracts the text layer from a valid PDF', async () => {
    const text = await extractPdfText(makePdf('Hello World from PDF'))
    expect(text).toContain('Hello World from PDF')
  })

  it('throws on a non-PDF buffer (callers treat it as non-fatal)', async () => {
    await expect(extractPdfText(new Uint8Array(Buffer.from('not a pdf at all')))).rejects.toThrow()
  })
})
