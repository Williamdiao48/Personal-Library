import { describe, it, expect, afterAll } from 'vitest'
import { extractPdf } from './pdf'
import { makePdfFile, writeTempPdf, cleanupTempPdfs } from '../../../../test/fixtures/pdf'

// Exercises the REAL bundled pdfjs-dist (no mock) through the shared extractor —
// the exact code path the Cloud Run container runs — so local↔cloud parity rests
// on one source of truth. pdfjs-dist is pure JS, so this needs no ABI toggle.

describe('extractPdf (real pdfjs-dist)', () => {
  afterAll(cleanupTempPdfs)

  it('extracts plaintext + word count from a valid PDF', async () => {
    const path = makePdfFile('Hello World from PDF')
    const result = await extractPdf(path)
    expect(result.plainText).toContain('Hello World from PDF')
    expect(result.wordCount).toBe(4)
  })

  it('is best-effort on a non-PDF file: empty text, null word count, no throw', async () => {
    const path = writeTempPdf(new Uint8Array(Buffer.from('not a pdf at all')), 'garbage.pdf')
    const result = await extractPdf(path)
    expect(result).toEqual({ plainText: '', wordCount: null })
  })
})
