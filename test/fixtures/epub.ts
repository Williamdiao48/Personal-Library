// EPUB fixture builder for parser tests. Constructs a spec-shaped EPUB (mimetype,
// META-INF/container.xml, OPF with manifest + spine, chapter XHTML, optional
// cover) in memory via AdmZip, with escape hatches for malformed variants.
//
// parseEpubMetadata / extractEpubContent take a file PATH, so writeTempEpub()
// materializes the buffer to a temp file and tracks it for cleanup.
import AdmZip from 'adm-zip'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 1×1 transparent PNG (same bytes used across the parser suites).
export const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

export interface EpubChapter {
  /** filename relative to the OPF directory, e.g. "chap1.xhtml" */
  href: string
  title?: string
  /** inner <body> HTML; a full XHTML doc is generated around it */
  body?: string
  /** id in the manifest/spine (defaults to href without extension) */
  id?: string
}

export interface EpubOptions {
  title?: string
  author?: string
  /** directory inside the zip holding the OPF + content, e.g. "OEBPS/" ("" = root) */
  opfDir?: string
  chapters?: EpubChapter[]
  cover?: { href: string; data?: Buffer; useProperties?: boolean }
  omitMimetype?: boolean
  /** Fully override container.xml (malformed-fixture escape hatch). */
  containerXml?: string
  /** Fully override the OPF contents (malformed-fixture escape hatch). */
  opfContent?: string
}

function chapterXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${title}</title></head>
<body>${body}</body>
</html>`
}

/** Build the raw bytes of an EPUB. Round-trips through a buffer so entry headers
 *  are populated (needed by assertEntryInflateOk). */
export function buildEpub(opts: EpubOptions = {}): Buffer {
  const {
    title = 'Test Book',
    author = 'Test Author',
    opfDir = 'OEBPS/',
    cover,
    omitMimetype = false,
  } = opts

  const chapters: EpubChapter[] =
    opts.chapters ?? [{ href: 'chap1.xhtml', title: 'Chapter 1', body: '<p>Hello world.</p>' }]

  const zip = new AdmZip()

  // mimetype (spec: first entry, stored) — parsers don't require it, but realistic.
  if (!omitMimetype) zip.addFile('mimetype', Buffer.from('application/epub+zip'))

  const opfPath = `${opfDir}content.opf`
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      opts.containerXml ??
        `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    ),
  )

  // Chapter files.
  for (const ch of chapters) {
    zip.addFile(
      `${opfDir}${ch.href}`,
      Buffer.from(chapterXhtml(ch.title ?? 'Chapter', ch.body ?? '<p>...</p>')),
    )
  }

  // Cover image + manifest/metadata wiring.
  let coverMeta = ''
  let coverItem = ''
  if (cover) {
    zip.addFile(`${opfDir}${cover.href}`, cover.data ?? PNG_1x1)
    if (cover.useProperties) {
      coverItem = `<item id="cover-img" href="${cover.href}" media-type="image/png" properties="cover-image"/>`
    } else {
      coverMeta = `<meta name="cover" content="cover-img"/>`
      coverItem = `<item id="cover-img" href="${cover.href}" media-type="image/png"/>`
    }
  }

  const manifestItems = chapters
    .map(
      (ch) =>
        `<item id="${ch.id ?? ch.href.replace(/\.[^.]+$/, '')}" href="${ch.href}" media-type="application/xhtml+xml"/>`,
    )
    .join('\n    ')
  const spineRefs = chapters
    .map((ch) => `<itemref idref="${ch.id ?? ch.href.replace(/\.[^.]+$/, '')}"/>`)
    .join('\n    ')

  zip.addFile(
    opfPath,
    Buffer.from(
      opts.opfContent ??
        `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifestItems}
    ${coverItem}
  </manifest>
  <spine>
    ${spineRefs}
  </spine>
</package>`,
    ),
  )

  return new AdmZip(zip.toBuffer()).toBuffer()
}

// ── Temp-file materialization ────────────────────────────────────────────────

let tmpDir: string | null = null
const created: string[] = []

/** Write an EPUB buffer to a temp .epub file and return its path. */
export function writeTempEpub(buf: Buffer, name = 'book.epub'): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'pl-epub-'))
  const p = join(tmpDir, `${created.length}-${name}`)
  writeFileSync(p, buf)
  created.push(p)
  return p
}

/** Convenience: build + write in one call. */
export function makeEpubFile(opts?: EpubOptions, name?: string): string {
  return writeTempEpub(buildEpub(opts), name)
}

/** Remove all temp EPUBs. Call in afterAll. */
export function cleanupTempEpubs(): void {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
    created.length = 0
  }
}
