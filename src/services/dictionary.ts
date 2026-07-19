import type { DictionaryResult } from '../types'

// Thin wrapper over window.api.dictionary — the renderer never touches
// window.api directly. Offline WordNet lookup; resolves to { found: false }
// for unknown words rather than rejecting.
export const dictionaryService = {
  lookup: (word: string): Promise<DictionaryResult> => window.api.dictionary.lookup(word),
}
