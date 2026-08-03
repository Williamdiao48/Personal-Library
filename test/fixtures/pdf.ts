// PDF fixture builder for extractor tests. Constructs a tiny but spec-valid
// single-page PDF whose content stream draws `text`, with real xref offsets so
// pdf.js recovers a text layer without its error-recovery path. Mirrors the
// inline helper that pdfText.test.ts pioneered, promoted here so the shared
// extractor unit test, the Cloud Run container test, and the parity spike can
// all build the same PDFs.
//
// extractPdf takes a file PATH, so makePdfFile() materializes the bytes to a
// temp file and tracks it for cleanup (parallel to test/fixtures/epub.ts).
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Build the raw bytes of a minimal single-page PDF that renders `text`. */
export function buildPdf(text: string): Uint8Array {
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

// ── Temp-file materialization ────────────────────────────────────────────────

let tmpDir: string | null = null
const created: string[] = []

/** Write PDF bytes to a temp .pdf file and return its path. */
export function writeTempPdf(bytes: Uint8Array, name = 'doc.pdf'): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'pl-pdf-'))
  const p = join(tmpDir, `${created.length}-${name}`)
  writeFileSync(p, bytes)
  created.push(p)
  return p
}

/** Convenience: build + write in one call. */
export function makePdfFile(text: string, name?: string): string {
  return writeTempPdf(buildPdf(text), name)
}

/** Remove all temp PDFs. Call in afterAll. */
export function cleanupTempPdfs(): void {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
    created.length = 0
  }
}
