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

/** Inverse of packArchive. Throws if the buffer isn't a valid archive. */
export function unpackArchive(buf: Buffer): ArchiveEntry[] {
  if (!buf.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC, 'utf8'))) {
    throw new Error('not a PLAR1 archive (bad magic)')
  }
  const nl = buf.indexOf(0x0a, MAGIC.length) // first newline after the header JSON
  if (nl === -1) throw new Error('malformed archive: no header terminator')
  const header = JSON.parse(buf.subarray(MAGIC.length, nl).toString('utf8')) as {
    files: { name: string; len: number }[]
  }
  const entries: ArchiveEntry[] = []
  let offset = nl + 1
  for (const f of header.files) {
    entries.push({ name: f.name, data: buf.subarray(offset, offset + f.len) })
    offset += f.len
  }
  return entries
}
