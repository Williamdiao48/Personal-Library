import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'path'
import { tmpdir } from 'os'
import { resolveWithin, safeContentPath, safeUserDataPath, contentDir } from './paths'

// A real absolute base on any platform (resolve/sep keep the tests portable
// across posix and win32 CI runners).
const BASE = resolve(tmpdir(), 'pl-base', 'content')

describe('resolveWithin — rejects traversal outside the base', () => {
  const escapes = [
    '../etc/passwd',
    '../../../../etc/passwd',
    'content/../../x',
    '..',
    '', // empty resolves to the base itself — not strictly *inside* it
    '.', // ditto
    '../content_backup/x', // sibling dir whose name starts with the base's
  ]
  for (const rel of escapes) {
    it(`throws for ${JSON.stringify(rel)}`, () => {
      expect(() => resolveWithin(BASE, rel)).toThrow('Invalid content path')
    })
  }
})

describe('resolveWithin — contains safe paths inside the base', () => {
  const safe = ['file.html', 'sub/dir/file.html', 'uuid-ch0.html']
  for (const rel of safe) {
    it(`returns an in-base absolute path for ${JSON.stringify(rel)}`, () => {
      const full = resolveWithin(BASE, rel)
      expect(full).toBe(resolve(BASE, rel))
      expect(full.startsWith(BASE + sep)).toBe(true)
    })
  }

  it('neutralizes a leading-slash "absolute" input by containing it under base', () => {
    // path.join treats a leading slash as a segment, so this cannot escape —
    // it is contained inside the sandbox rather than resolving to the real root.
    const full = resolveWithin(BASE, '/etc/passwd')
    expect(full.startsWith(BASE + sep)).toBe(true)
  })
})

describe('Electron-bound wrappers compose correctly', () => {
  it('safeContentPath resolves under <userData>/content', () => {
    const full = safeContentPath('a.html')
    expect(full).toBe(resolve(contentDir(), 'a.html'))
    expect(full.startsWith(contentDir() + sep)).toBe(true)
  })

  it('safeContentPath rejects traversal', () => {
    expect(() => safeContentPath('../../secret')).toThrow('Invalid content path')
  })

  it('safeUserDataPath resolves a content/-prefixed cover path under userData', () => {
    // cover_path values are stored WITH the `content/` prefix.
    const full = safeUserDataPath('content/a-cover.jpg')
    expect(full.endsWith(`content${sep}a-cover.jpg`)).toBe(true)
  })

  it('safeUserDataPath rejects traversal', () => {
    expect(() => safeUserDataPath('../../../etc/passwd')).toThrow('Invalid content path')
  })
})
