import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../../test/stubs/electron'
import { contentFileNames, buildContentBlob, buildCoverBlob } from './itemBlob'
import { unpackArchive } from './blobArchive'

// itemBlob reads real files from <userData>/content, so give each test its own
// mkdtemp userData (the shared-content-dir race) via a scoped app.getPath spy.
let userData: string
let contentPath: string
let getPathSpy: ReturnType<typeof vi.spyOn>

const writeContent = (name: string, body: string) => writeFileSync(join(contentPath, name), body)

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'pl-itemblob-'))
  contentPath = join(userData, 'content')
  mkdirSync(contentPath, { recursive: true })
  getPathSpy = vi
    .spyOn(app, 'getPath')
    .mockImplementation((name: string) =>
      name === 'userData' ? userData : join('/tmp', `pl-test-${name}`),
    )
})
afterEach(() => {
  getPathSpy.mockRestore()
  rmSync(userData, { recursive: true, force: true })
})

describe('contentFileNames', () => {
  it('returns just file_path for a single-file item', () => {
    expect(contentFileNames({ id: 'e1', file_path: 'e1.epub', cover_path: null })).toEqual([
      'e1.epub',
    ])
  })

  it('enumerates all chapter siblings, numerically sorted, for multi-chapter HTML', () => {
    // Deliberately create out-of-order and double-digit chapters.
    for (const i of [0, 2, 1, 10]) writeContent(`m1-ch${i}.html`, `c${i}`)
    writeContent('other-ch0.html', 'nope') // a different item must not leak in
    expect(contentFileNames({ id: 'm1', file_path: 'm1-ch0.html', cover_path: null })).toEqual([
      'm1-ch0.html',
      'm1-ch1.html',
      'm1-ch2.html',
      'm1-ch10.html',
    ])
  })
})

describe('buildContentBlob', () => {
  it('packs a single-file item into a 1-entry archive and hashes it', () => {
    writeContent('e1.epub', 'EPUBBYTES')
    const { data, hash } = buildContentBlob({ id: 'e1', file_path: 'e1.epub', cover_path: null })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const entries = unpackArchive(data)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('e1.epub')
    expect(entries[0].data.toString('utf8')).toBe('EPUBBYTES')
  })

  it('packs every chapter of a multi-chapter item into one blob', () => {
    writeContent('m1-ch0.html', 'zero')
    writeContent('m1-ch1.html', 'one')
    const { data } = buildContentBlob({ id: 'm1', file_path: 'm1-ch0.html', cover_path: null })
    const names = unpackArchive(data).map((e) => e.name)
    expect(names).toEqual(['m1-ch0.html', 'm1-ch1.html'])
  })

  it('produces a stable hash for identical content (dedupe)', () => {
    writeContent('a.epub', 'IDENTICAL')
    const h1 = buildContentBlob({ id: 'a', file_path: 'a.epub', cover_path: null }).hash
    writeContent('a.epub', 'IDENTICAL')
    const h2 = buildContentBlob({ id: 'a', file_path: 'a.epub', cover_path: null }).hash
    expect(h1).toBe(h2)
  })
})

describe('buildCoverBlob', () => {
  it('returns null when the item has no cover', () => {
    expect(buildCoverBlob({ id: 'x', file_path: 'x.epub', cover_path: null })).toBeNull()
  })

  it('reads the raw cover image (content/ prefix) and hashes it', () => {
    writeContent('c1-cover.jpg', 'JPEGBYTES')
    const blob = buildCoverBlob({
      id: 'c1',
      file_path: 'c1.epub',
      cover_path: 'content/c1-cover.jpg',
    })
    expect(blob).not.toBeNull()
    expect(blob!.data.toString('utf8')).toBe('JPEGBYTES')
    expect(blob!.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
