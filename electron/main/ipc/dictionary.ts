import { ipcMain } from 'electron'
import type { DictionaryResult } from '../../../src/types'
import { lookupWord } from '../dictionary/lookup'

// The dictionary IPC seam. A single synchronous-style handler over the bundled
// read-only WordNet DB — no network, no writes. lookupWord() is total (never
// throws), so a bad input or a missing asset returns { found: false }.
export function registerDictionaryHandlers(): void {
  ipcMain.handle('dictionary:lookup', (_e, word: string): DictionaryResult => {
    if (typeof word !== 'string') return { word: '', found: false, entries: [] }
    return lookupWord(word)
  })
}
