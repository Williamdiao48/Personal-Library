#!/usr/bin/env node
// Vendors the int8 embedding model (bge-small-en-v1.5) into resources/models/
// so the recommender's Embedder can load it offline (env.allowRemoteModels=false).
//
// The model is NOT committed (see .gitignore) — no git-lfs in this repo, and it's
// ~35 MB. Run once before `npm run dev` / `npm run package`:
//
//     npm run fetch:model
//
// Layout produced (matches transformers.js dtype:'q8' local resolution — it loads
// <modelDir>/onnx/model_quantized.onnx):
//
//     resources/models/bge-small-en-v1.5-int8/
//       config.json  tokenizer.json  tokenizer_config.json
//       special_tokens_map.json  vocab.txt
//       onnx/model_quantized.onnx
//
// Source: https://huggingface.co/Xenova/bge-small-en-v1.5 (ONNX weights for
// transformers.js). Idempotent: existing non-empty files are skipped unless --force.

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HF_REPO = 'Xenova/bge-small-en-v1.5'
const HF_REV = 'main'
const MODEL_DIR_NAME = 'bge-small-en-v1.5-int8'

// Files pulled from the HF repo → written to the same relative path locally.
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'onnx/model_quantized.onnx', // the int8 (dtype:'q8') weights
]

const projectRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const outDir = join(projectRoot, 'resources', 'models', MODEL_DIR_NAME)
const force = process.argv.includes('--force')

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function exists(p) {
  try {
    const s = await stat(p)
    return s.size > 0
  } catch {
    return false
  }
}

async function fetchFile(rel) {
  const dest = join(outDir, rel)
  if (!force && (await exists(dest))) {
    console.log(`  ✓ ${rel} (already present, skipping)`)
    return
  }
  const url = `https://huggingface.co/${HF_REPO}/resolve/${HF_REV}/${rel}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download ${rel}: ${res.status} ${res.statusText}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  console.log(`  ↓ ${rel} (${fmtBytes(buf.length)})`)
}

async function main() {
  console.log(`Fetching ${HF_REPO} → ${outDir}`)
  await mkdir(outDir, { recursive: true })
  for (const rel of FILES) {
    await fetchFile(rel)
  }
  console.log('Done. Model vendored for offline use.')
}

main().catch((err) => {
  console.error('\nfetch-embedding-model failed:', err.message)
  process.exit(1)
})
