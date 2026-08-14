import AdmZip from 'adm-zip'
import { extname } from 'path'
import {
  readEntryTextCapped,
  assertEntryInflateOk,
  normalizeCoverExt,
  COVER_MAX_BYTES,
} from '../../security/validation'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface EpubMetadata {
  title: string | null
  author: string | null
  coverBuffer: Buffer | null
  coverExt: string | null
}

export function parseEpubMetadata(filePath: string): EpubMetadata {
  const empty: EpubMetadata = { title: null, author: null, coverBuffer: null, coverExt: null }
  try {
    const zip = new AdmZip(filePath)

    // Find the OPF file path via META-INF/container.xml
    const containerXml = readEntryTextCapped(zip, 'META-INF/container.xml') ?? ''
    const opfPathMatch = /full-path="([^"]+\.opf)"/i.exec(containerXml)
    if (!opfPathMatch) return empty

    const opfPath = opfPathMatch[1]
    const opfContent = readEntryTextCapped(zip, opfPath) ?? ''

    // Extract title and author from Dublin Core elements
    const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/i.exec(opfContent)?.[1]?.trim() ?? null
    const author = /<dc:creator[^>]*>([^<]+)<\/dc:creator>/i.exec(opfContent)?.[1]?.trim() ?? null

    // Locate cover image href in the manifest
    // Method 1: <meta name="cover" content="<item-id>" />
    const coverMetaId = /<meta\s+name="cover"\s+content="([^"]+)"/i.exec(opfContent)?.[1]
    let coverHref: string | null = null
    if (coverMetaId) {
      const eid = escapeRegExp(coverMetaId)
      coverHref =
        new RegExp(`<item[^>]+id="${eid}"[^>]+href="([^"]+)"`, 'i').exec(opfContent)?.[1] ??
        new RegExp(`<item[^>]+href="([^"]+)"[^>]+id="${eid}"`, 'i').exec(opfContent)?.[1] ??
        null
    }
    // Method 2: <item properties="cover-image" href="...">
    if (!coverHref) {
      coverHref =
        /<item[^>]+properties="cover-image"[^>]+href="([^"]+)"/i.exec(opfContent)?.[1] ??
        /<item[^>]+href="([^"]+)"[^>]+properties="cover-image"/i.exec(opfContent)?.[1] ??
        null
    }

    let coverBuffer: Buffer | null = null
    let coverExt: string | null = null

    if (coverHref) {
      // Resolve href relative to the OPF file's directory
      const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
      const coverZipPath = coverHref.startsWith('/') ? coverHref.slice(1) : opfDir + coverHref
      const entry = zip.getEntry(coverZipPath)
      if (entry) {
        assertEntryInflateOk(entry)
        // Enforce the shared 10 MiB cover cap here (mirrors cloudExtractEpub's
        // SEC-4 cap) so local and cloud imports agree: an over-cap cover is
        // dropped — the book imports cover-less rather than with a 10–25 MiB
        // cover the cloud path would have discarded. `assertEntryInflateOk`
        // already bounds the decompressed size to ZIP_ENTRY_MAX_BYTES (25 MiB),
        // so getData() here is safe before this tighter cover-specific check.
        const data = entry.getData()
        if (data.length <= COVER_MAX_BYTES) {
          coverBuffer = data
          coverExt = normalizeCoverExt(extname(coverHref).slice(1))
        }
      }
    }

    return { title, author, coverBuffer, coverExt }
  } catch {
    return empty
  }
}
