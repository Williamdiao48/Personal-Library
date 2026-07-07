import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// C1.1 config-drift guard. The recommender's embedding model + the onnxruntime
// native/WASM binaries only reach the packaged app through electron-builder
// `extraResources` / `asarUnpack`. A real `--dir` build (2026-07-07) confirmed
// they land correctly, but CI does NOT package — so this static guard is the
// only automated protection against someone editing package.json and silently
// dropping one of these (which would ship a release whose embedder can't load
// its model or its native binary). It asserts the config exists; it does not
// re-verify packaging behaviour (that needs an actual build — see chunk1 plan §6).
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'))

describe('C1.1 packaging config for the embedding runtime', () => {
  it('declares transformers.js as a runtime dependency (not dev)', () => {
    expect(pkg.dependencies?.['@huggingface/transformers']).toBeTruthy()
    expect(pkg.devDependencies?.['@huggingface/transformers']).toBeUndefined()
  })

  it('exposes the model-vendoring script', () => {
    expect(pkg.scripts?.['fetch:model']).toContain('fetch-embedding-model')
  })

  it('ships the vendored model via extraResources (models → models)', () => {
    const entries = pkg.build?.extraResources ?? []
    const modelEntry = entries.find(
      (e: { from?: string; to?: string }) => e.from === 'resources/models' && e.to === 'models'
    )
    expect(modelEntry).toBeDefined()
  })

  it('unpacks the onnxruntime native binary + WASM out of the asar', () => {
    const unpack: string[] = pkg.build?.asarUnpack ?? []
    // Native binary (napi-v6/**/*.node) — dlopen fails from inside an asar.
    expect(unpack.some((g) => g.includes('onnxruntime-node/bin'))).toBe(true)
    // WASM fallback binaries (Intel-Mac / non-native backend).
    expect(unpack.some((g) => g.includes('onnxruntime-web') && g.includes('.wasm'))).toBe(true)
  })
})
