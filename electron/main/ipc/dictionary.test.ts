import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke, resetIpc } from '../../../test/stubs/electron'
import type { DictionaryResult } from '../../../src/types'

// The IPC glue only: registerDictionaryHandlers wires 'dictionary:lookup' to
// lookupWord and guards a non-string payload. lookupWord itself is unit-tested
// in ../dictionary/lookup.test.ts, so it's mocked here.

import { registerDictionaryHandlers } from './dictionary'

const lookupMock = vi.fn<(w: string) => DictionaryResult>()
vi.mock('../dictionary/lookup', () => ({ lookupWord: (w: string) => lookupMock(w) }))

describe('dictionary IPC', () => {
  beforeEach(() => {
    resetIpc()
    lookupMock.mockReset()
    registerDictionaryHandlers()
  })

  it('delegates a string word to lookupWord and returns its result', async () => {
    const result: DictionaryResult = {
      word: 'book',
      found: true,
      entries: [{ pos: 'noun', senses: [{ definition: 'a written work', synonyms: [] }] }],
    }
    lookupMock.mockReturnValue(result)
    expect(await invoke('dictionary:lookup', 'book')).toEqual(result)
    expect(lookupMock).toHaveBeenCalledWith('book')
  })

  it('returns an empty not-found result for a non-string payload without calling lookup', async () => {
    expect(await invoke('dictionary:lookup', 42)).toEqual({
      word: '',
      found: false,
      entries: [],
    })
    expect(lookupMock).not.toHaveBeenCalled()
  })
})
