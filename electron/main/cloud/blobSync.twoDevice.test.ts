import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app, dialog, invoke, resetIpc } from '../../../test/stubs/electron'
import { makeFakeServer } from '../../../test/cloud/fakeSyncServer'
import { bringUpSchema, __setTestDb } from '../db/index'
import { runSyncRound } from './sync/syncEngine'
import { sha256Hex } from './blobHash'
import { unpackArchive } from './blobArchive'
import type { SiteContent } from '../capture/fetch'

// ─────────────────────────────────────────────────────────────────────────────
// Two-device blob simulation: the automated stand-in for "append on device A, then
// open the book on device B".
//
// Everything between the user action and the bytes landing on another device is
// REAL: library:refresh / library:pickCover IPC → appendChapters (real chapter-file
// writes) → refreshItemBackup → uploader (pack, hash, drift check, drain) →
// runSyncRound (real push/pull/LWW of the items row) → downloader (GET, integrity
// check, unpack). Only the network edges are fakes:
//   • R2         — an in-memory object store keyed by hash. It ENFORCES the
//                  content-addressing invariant real R2 does not: every PUT's sha256
//                  must equal its key. A violation is the CLO-7 corruption.
//   • Postgres   — the shared fake sync server (cursor pull, server-stamped clock).
//   • the site   — the Royal Road parser, so an "append" fetches canned chapters.
// Each device has its own SQLite DB and its own userData/content dir; `on(device)`
// points the db singleton and app.getPath('userData') at it.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({ signedIn: true }))

vi.mock('../auth/client', () => ({
  isConfigured: () => true,
  getSupabase: () => ({
    auth: {
      getSession: async () => ({
        data: { session: h.signedIn ? { access_token: 't' } : null },
      }),
    },
  }),
}))
vi.mock('./presign', () => ({
  presignBlobUrl: vi.fn(async (_op: string, kind: string, hash: string) => `r2://${kind}/${hash}`),
}))
vi.mock('../capture/sites/royalroad', () => ({
  captureRoyalRoad: vi.fn(),
  getRoyalRoadChapterCount: vi.fn(),
}))
vi.mock('../recommender/lifecycle', () => ({ triggerBackfill: vi.fn() }))
vi.mock('./sync/syncService', () => ({ notifyLocalMutation: vi.fn() }))

import { registerLibraryHandlers } from '../ipc/library'
import { enqueueItemBackup, drainOutbox } from './uploader'
import { ensureLocalContent, ensureLocalCover } from './downloader'
import { captureRoyalRoad, getRoyalRoadChapterCount } from '../capture/sites/royalroad'

// ── Fake R2 ──────────────────────────────────────────────────────────────────
const r2 = new Map<string, Buffer>()
const violations: string[] = []
const puts: string[] = []

async function fakeFetch(input: unknown, init?: { method?: string; body?: Uint8Array }) {
  const url = String(input)
  if (!url.startsWith('r2://')) throw new Error('offline') // library:refresh's HEAD → proceed
  const key = url.slice('r2://'.length) // `<kind>/<hash>`
  const hash = key.split('/')[1]
  if (init?.method === 'PUT') {
    const body = Buffer.from(init.body!)
    puts.push(key)
    if (sha256Hex(body) !== hash)
      violations.push(`PUT ${key} carried bytes hashing to ${sha256Hex(body)}`)
    r2.set(key, body)
    return { ok: true, status: 200, text: async () => '' }
  }
  const obj = r2.get(key)
  if (!obj) return { ok: false, status: 404, headers: { get: () => null } }
  return {
    ok: true,
    status: 200,
    headers: {
      get: (n: string) => (n.toLowerCase() === 'content-length' ? String(obj.length) : null),
    },
    arrayBuffer: async () => obj.buffer.slice(obj.byteOffset, obj.byteOffset + obj.byteLength),
  }
}

// ── Devices ──────────────────────────────────────────────────────────────────
interface Device {
  name: string
  db: Database.Database
  userData: string
}
const devices: Device[] = []

function newDevice(name: string): Device {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  bringUpSchema(db)
  const userData = mkdtempSync(join(tmpdir(), `pl-2dev-${name}-`))
  mkdirSync(join(userData, 'content'), { recursive: true })
  const d = { name, db, userData }
  devices.push(d)
  return d
}

let current: Device | null = null
function on(d: Device): Device {
  current = d
  __setTestDb(d.db)
  return d
}

const contentFiles = (d: Device) => readdirSync(join(d.userData, 'content')).sort()
const read = (d: Device, name: string) => readFileSync(join(d.userData, 'content', name), 'utf8')
const itemRow = (d: Device, id: string) =>
  d.db
    .prepare('SELECT blob_hash, cover_hash, cover_path, chapter_end FROM items WHERE id = ?')
    .get(id) as {
    blob_hash: string | null
    cover_hash: string | null
    cover_path: string | null
    chapter_end: number | null
  }

let server: ReturnType<typeof makeFakeServer>

/** Let every background drain on the current device finish before switching. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0))
    await drainOutbox()
  }
}
async function sync(d: Device): Promise<void> {
  on(d)
  await settle()
  const report = await runSyncRound(d.db, server.repo)
  expect(report.ok).toBe(true)
}

const SERIAL = 'https://www.royalroad.com/fiction/1'
const chapterHtml = (n: number) => `<div class="chapter"><p>chapter ${n} words</p></div>`
const site = (chapters: number[]): SiteContent => ({
  title: 'Serial',
  author: 'Author',
  html: chapters.map(chapterHtml).join(''),
  textContent: chapters.map((n) => `chapter ${n} words`).join(' '),
  coverUrl: null,
})

/** A two-chapter serial captured on `d` with cloud backup on, uploaded. */
async function captureBackedUpSerial(d: Device, id = 'serial'): Promise<string> {
  on(d)
  d.db
    .prepare(
      `INSERT INTO items (id, title, author, source_url, content_type, file_path, word_count,
         date_saved, date_modified, chapter_start, chapter_end, cloud_backup)
       VALUES (?, 'Serial', 'Author', ?, 'article', ?, 6, 1, 1, 1, 2, 1)`,
    )
    .run(id, SERIAL, `${id}-ch0.html`)
  d.db
    .prepare(
      `INSERT INTO items_fts (rowid, title, author, content)
       SELECT rowid, title, author, ? FROM items WHERE id = ?`,
    )
    .run('chapter 0 words chapter 1 words', id)
  writeFileSync(join(d.userData, 'content', `${id}-ch0.html`), chapterHtml(0))
  writeFileSync(join(d.userData, 'content', `${id}-ch1.html`), chapterHtml(1))
  await enqueueItemBackup(id)
  await settle()
  return id
}

/** Device `d` refreshes the serial and the site now reports `total` chapters. */
async function appendViaRefresh(d: Device, id: string, total: number, from: number) {
  on(d)
  vi.mocked(getRoyalRoadChapterCount).mockResolvedValue(total)
  vi.mocked(captureRoyalRoad).mockResolvedValue(
    site(Array.from({ length: total - from }, (_, i) => from + i)),
  )
  const res = (await invoke('library:refresh', id)) as { changed: boolean }
  expect(res.changed).toBe(true)
  await settle()
}

/** "Open the book" on `d`: pull-on-open, then return what the reader would see. */
async function openOn(d: Device, id: string): Promise<string[]> {
  on(d)
  const { file_path } = d.db.prepare('SELECT file_path FROM items WHERE id = ?').get(id) as {
    file_path: string
  }
  await ensureLocalContent(file_path)
  return contentFiles(d).filter((n) => n.startsWith(`${id}-ch`))
}

beforeEach(() => {
  r2.clear()
  violations.length = 0
  puts.length = 0
  h.signedIn = true
  server = makeFakeServer()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.spyOn(app, 'getPath').mockImplementation((n: string) =>
    n === 'userData' ? (current?.userData ?? '/tmp/pl-2dev-none') : `/tmp/pl-test-${n}`,
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetIpc()
  registerLibraryHandlers()
})

afterEach(async () => {
  // The invariant the whole fix exists for, checked after EVERY scenario.
  expect(violations).toEqual([])
  await settle().catch(() => {})
  for (const d of devices.splice(0)) {
    d.db.close()
    rmSync(d.userData, { recursive: true, force: true })
  }
  current = null
  __setTestDb(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('two devices, one backed-up serial', () => {
  it('baseline: B opens exactly what A backed up', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    const id = await captureBackedUpSerial(A)
    await sync(A)
    await sync(B)

    expect(await openOn(B, id)).toEqual([`${id}-ch0.html`, `${id}-ch1.html`])
    expect(read(B, `${id}-ch1.html`)).toBe(chapterHtml(1))
  })

  it('chapters appended on A after the backup synced reach a fresh B (stale-pointer bug)', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    const id = await captureBackedUpSerial(A)
    await sync(A)
    const before = itemRow(A, id).blob_hash

    await appendViaRefresh(A, id, 4, 2)
    expect(itemRow(A, id).blob_hash).not.toBe(before)
    await sync(A)
    await sync(B)

    expect(itemRow(B, id)).toMatchObject({ blob_hash: itemRow(A, id).blob_hash, chapter_end: 4 })
    expect(await openOn(B, id)).toEqual([0, 1, 2, 3].map((n) => `${id}-ch${n}.html`))
    for (const n of [0, 1, 2, 3])
      expect(read(B, `${id}-ch${n}.html`)).toBe(read(A, `${id}-ch${n}.html`))
  })

  it('append while the first upload is still pending never PUTs new bytes under the old key (poison race)', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    h.signedIn = false // offline/signed-out: the first upload stays queued
    const id = await captureBackedUpSerial(A)
    const original = itemRow(A, id).blob_hash!
    await appendViaRefresh(A, id, 3, 2)

    h.signedIn = true
    await sync(A) // drains the queue, then pushes the row
    await sync(B)

    expect(puts).not.toContain(`content/${original}`)
    expect(await openOn(B, id)).toEqual([0, 1, 2].map((n) => `${id}-ch${n}.html`))
  })

  it('bytes changed by a writer that FORGOT refreshItemBackup still never poison a key (backstop)', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    h.signedIn = false
    const id = await captureBackedUpSerial(A)
    const original = itemRow(A, id).blob_hash!
    // A hypothetical future write path edits a chapter without re-addressing.
    writeFileSync(join(A.userData, 'content', `${id}-ch1.html`), chapterHtml(99))

    h.signedIn = true
    await sync(A)
    await sync(B)

    expect(puts).not.toContain(`content/${original}`)
    expect(itemRow(A, id).blob_hash).not.toBe(original) // the drain re-addressed it
    await openOn(B, id)
    expect(read(B, `${id}-ch1.html`)).toBe(chapterHtml(99))
  })

  it('a metadata-only B appends without losing the earlier chapters, and a third device sees all of them', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    const C = newDevice('C')
    const id = await captureBackedUpSerial(A)
    await sync(A)
    await sync(B)
    expect(contentFiles(B)).toEqual([]) // B has the row, not the bytes

    await appendViaRefresh(B, id, 3, 2) // pulls ch0–1 first, then writes ch2
    expect(contentFiles(B)).toEqual([0, 1, 2].map((n) => `${id}-ch${n}.html`))
    await sync(B)

    // The archive B published holds every chapter, not just the appended one.
    const archive = unpackArchive(r2.get(`content/${itemRow(B, id).blob_hash}`)!, 1e9)
    expect(archive.map((e) => e.name).sort()).toEqual([0, 1, 2].map((n) => `${id}-ch${n}.html`))

    await sync(C)
    expect(await openOn(C, id)).toEqual([0, 1, 2].map((n) => `${id}-ch${n}.html`))
    expect(read(C, `${id}-ch0.html`)).toBe(chapterHtml(0))
  })

  it('a cover picked on A reaches a fresh B', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    const id = await captureBackedUpSerial(A)
    await sync(A)

    on(A)
    const src = join(A.userData, 'picked.png')
    writeFileSync(src, 'NEW-COVER-BYTES')
    vi.spyOn(dialog, 'showOpenDialog').mockResolvedValue({ canceled: false, filePaths: [src] })
    await invoke('library:pickCover', id)
    await sync(A)
    await sync(B)

    on(B)
    const { cover_path, cover_hash } = itemRow(B, id)
    expect(cover_hash).toBe(sha256Hex(Buffer.from('NEW-COVER-BYTES')))
    await ensureLocalCover(cover_path!)
    expect(readFileSync(join(B.userData, cover_path!), 'utf8')).toBe('NEW-COVER-BYTES')
  })

  // KNOWN GAP (CLO-7 follow-up, not fixed here): a peer that ALREADY opened the book
  // keeps its old local files. ensureLocalContent short-circuits on existsSync(ch0), so
  // the re-addressed blob is never fetched and the appended chapters never appear.
  // `it.fails` passes while the bug exists; when it's fixed this flips red, prompting
  // removal of `.fails`.
  it.fails('a B that already opened the book picks up chapters A appends later', async () => {
    const A = newDevice('A')
    const B = newDevice('B')
    const id = await captureBackedUpSerial(A)
    await sync(A)
    await sync(B)
    await openOn(B, id) // B now holds ch0–1 locally

    await appendViaRefresh(A, id, 3, 2)
    await sync(A)
    await sync(B)

    expect(await openOn(B, id)).toEqual([0, 1, 2].map((n) => `${id}-ch${n}.html`))
  })
})
