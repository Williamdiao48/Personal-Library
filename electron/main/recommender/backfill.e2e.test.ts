import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { openTestDb, closeTestDb, seedItem } from '../../../test/db/harness'
import { contentDir } from '../security/paths'
import { runBackfill, _resetBackfillState } from './backfill'
import { getEmbedding } from './store'
import { embedItemVector } from './embeddingText'
import {
  createExtractor,
  embedWith,
  MODEL_VERSION,
  EMBED_DIM,
  type Embedder,
} from './embedder-core'
import type { EmbedHost } from './embedHost'
import { run } from '../db'

// C2.7 — opt-in end-to-end for the whole Chunk-2 pipeline with the REAL vendored
// model: reconcile → backfill → extractPlainText (reads a real content file) →
// embedItemVector (Tier-A + Tier-B, real onnxruntime) → store, plus the
// staleness behavior (edit re-embeds; rating does not). Every other Chunk-2 test
// mocks or stubs the embedder; this proves the pieces actually compose end to end.
//
// It uses an IN-PROCESS host (createExtractor + embedWith) rather than the
// utilityProcess worker — the worker transport is verified by running the app
// (same as parse-host); here we exercise everything up to and including the
// model. Needs BOTH: the vendored model AND the better-sqlite3 Node ABI.
//
// Run:  npm run fetch:model                              (once)
//       npm run rebuild:node                             (Node ABI for openTestDb)
//       RUN_MODEL_TESTS=1 npx vitest run electron/main/recommender/backfill.e2e.test.ts
//       npm run rebuild:electron                         (restore)
const MODEL_DIR = join(process.cwd(), 'resources', 'models')
const modelPresent = existsSync(
  join(MODEL_DIR, 'bge-small-en-v1.5-int8', 'onnx', 'model_quantized.onnx'),
)
const enabled = process.env.RUN_MODEL_TESTS === '1' && modelPresent

const FIXTURE_FILE = 'c27-e2e.html'
const FIXTURE_HTML = `<html><body><article>
  <h1>The Cartographer's Apprentice</h1>
  <p>She had spent the better part of three winters copying maps she was
  forbidden to read, tracing coastlines that ended in rumor and mountain ranges
  drawn from a single traveler's fevered account. The guild paid in candle stubs
  and silence. Still, she stayed, because somewhere in the locked western
  cabinet was the only chart that showed the road home, and she meant to have
  it before the frost broke and the caravans left without her.</p>
  <p>The master cartographer trusted no one, least of all a girl who asked why
  the borders never matched the letters merchants carried. But trust, she had
  learned, was a thing you manufactured slowly, one flawless copy at a time,
  until the day he handed her the western key and told her to make herself
  useful. She did. She made herself unforgettable instead.</p>
</article></body></html>`

function l2norm(v: Float32Array): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

describe.runIf(enabled)('Chunk 2 end-to-end (real vendored model)', () => {
  let host: EmbedHost

  beforeAll(async () => {
    const pipe = await createExtractor(MODEL_DIR)
    const embedder: Embedder = {
      modelVersion: MODEL_VERSION,
      dim: EMBED_DIM,
      embed: (texts) => embedWith(pipe, texts),
    }
    host = {
      modelVersion: MODEL_VERSION,
      embed: (item, tags) => embedItemVector(item, tags, embedder),
    }
  }, 60_000)

  afterEach(() => {
    _resetBackfillState()
    closeTestDb()
    try {
      rmSync(join(contentDir(), FIXTURE_FILE))
    } catch {
      // best-effort cleanup
    }
  })

  it('backfills a real item, then re-embeds on edit but not on rating change', async () => {
    const db = openTestDb()
    mkdirSync(contentDir(), { recursive: true })
    writeFileSync(join(contentDir(), FIXTURE_FILE), FIXTURE_HTML, 'utf8')
    const id = seedItem(db, {
      title: "The Cartographer's Apprentice",
      author: 'E. Vale',
      content_type: 'article',
      file_path: FIXTURE_FILE,
      content_hash: 'v1',
    })

    // ── 1. First backfill: the item gets a real, well-formed embedding row ──
    const first = await runBackfill(host)
    expect(first).toMatchObject({ scanned: 1, stale: 1, embedded: 1, failed: 0 })

    const row = getEmbedding(id)
    expect(row).toBeDefined()
    expect(row!.embedding).toHaveLength(EMBED_DIM) // 384
    expect(l2norm(row!.embedding)).toBeCloseTo(1, 4) // blend() L2-normalizes
    expect(row!.modelVersion).toBe(MODEL_VERSION)
    expect(row!.contentHash).toBeTruthy()
    const hash1 = row!.contentHash

    // ── 2. Nothing changed → the staleness gate skips it (no wasted embed) ──
    const second = await runBackfill(host)
    expect(second.embedded).toBe(0)
    expect(second.stale).toBe(0)

    // ── 3. Editing Tier-A metadata (title) → re-embed, new content hash ─────
    run('UPDATE items SET title = ? WHERE id = ?', ['A New Title Entirely', id])
    const third = await runBackfill(host)
    expect(third.embedded).toBe(1)
    const hash2 = getEmbedding(id)!.contentHash
    expect(hash2).not.toBe(hash1)

    // ── 4. Changing rating (not an embedding input) → NO re-embed ───────────
    run('UPDATE items SET rating = ? WHERE id = ?', [5, id])
    const fourth = await runBackfill(host)
    expect(fourth.embedded).toBe(0)
    expect(getEmbedding(id)!.contentHash).toBe(hash2) // unchanged
  }, 120_000)
})
