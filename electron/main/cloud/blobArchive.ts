// A tiny DETERMINISTIC archive for Phase 2 blob sync. Every item maps to exactly
// one content blob (Decision 8 / the multi-file packaging decision), so a
// multi-chapter HTML fic — stored on disk as N `<id>-chK.html` files — packs into
// one blob, and single-file items (epub/pdf/single HTML) are just a 1-entry
// archive. Uniform: the uploader always packs, pull-on-open (chunk 5) always
// unpacks.
//
// Why not tar/zip: a standard tar embeds mtime/uid/gid → non-deterministic bytes
// → a different sha256 every pack of the same content, which would defeat
// content-addressing and dedupe. This format has NO timestamps and sorts entries
// by name, so identical files always produce byte-identical archives → a stable
// R2 key. Dependency-free (no external archiver).
//
// Layout:
//   "PLAR1\n"                                            magic + version
//   <json header>\n     {"files":[{"name","len"}, …]}   entries sorted by name
//   <raw bytes>                                          concatenated in header order

const MAGIC = 'PLAR1\n'

// A sane ceiling on entry count: even a very long multi-chapter fic is a few
// hundred files. This bounds the header loop against a malicious header that
// claims millions of entries.
const MAX_ENTRIES = 10_000

export interface ArchiveEntry {
  name: string
  data: Buffer
}

/** Pack entries into one deterministic archive buffer (order-independent input). */
export function packArchive(entries: ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const header = JSON.stringify({
    files: sorted.map((e) => ({ name: e.name, len: e.data.length })),
  })
  return Buffer.concat([
    Buffer.from(MAGIC, 'utf8'),
    Buffer.from(header + '\n', 'utf8'),
    ...sorted.map((e) => e.data),
  ])
}

/**
 * Inverse of packArchive. Throws if the buffer isn't a valid archive.
 *
 * The header is attacker-influenced once blobs sync between devices, so every
 * field is shape- and bounds-checked: a bad `len` that would run past the buffer
 * throws (rather than silently clamping via `subarray` → truncated content), the
 * entry count is capped, and `maxTotalBytes` bounds the summed entry size so a
 * lying header can't drive an unbounded allocation downstream.
 */
export function unpackArchive(buf: Buffer, maxTotalBytes = Infinity): ArchiveEntry[] {
  if (!buf.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC, 'utf8'))) {
    throw new Error('not a PLAR1 archive (bad magic)')
  }
  const nl = buf.indexOf(0x0a, MAGIC.length) // first newline after the header JSON
  if (nl === -1) throw new Error('malformed archive: no header terminator')

  let parsed: unknown
  try {
    parsed = JSON.parse(buf.subarray(MAGIC.length, nl).toString('utf8'))
  } catch {
    throw new Error('malformed archive: header is not valid JSON')
  }
  const files = (parsed as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) {
    throw new Error('malformed archive: header.files must be an array')
  }
  if (files.length > MAX_ENTRIES) {
    throw new Error('malformed archive: too many entries')
  }

  const entries: ArchiveEntry[] = []
  let offset = nl + 1
  let total = 0
  for (const f of files) {
    const name = (f as { name?: unknown } | null)?.name
    const len = (f as { len?: unknown } | null)?.len
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('malformed archive: entry name must be a non-empty string')
    }
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0) {
      throw new Error('malformed archive: entry len must be a non-negative integer')
    }
    const end = offset + len
    if (end > buf.length) {
      throw new Error('malformed archive: entry length runs past the buffer')
    }
    total += len
    if (total > maxTotalBytes) {
      throw new Error('malformed archive: total size exceeds the maximum allowed')
    }
    entries.push({ name, data: buf.subarray(offset, end) })
    offset = end
  }
  return entries
}
