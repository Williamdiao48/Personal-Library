import type {
  DictionaryEntry,
  DictionaryPos,
  DictionaryResult,
  DictionarySense,
} from '../../../src/types'
import { getDictionaryDb } from './db'

// Word lookup against the bundled WordNet DB. Strategy: exact match → curated
// irregular lemma (geese→goose) → rule-based inflection stripping (Morphy-style)
// → give up. The dictionary is read-only, so this is pure query logic.

const MAX_INPUT = 60 // reject pathological selections before touching the DB
const MAX_SENSES_PER_POS = 6

const POS_LABEL: Record<string, DictionaryPos> = {
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  r: 'adverb',
}
// Stable display order regardless of the DB's row order.
const POS_ORDER: DictionaryPos[] = ['noun', 'verb', 'adjective', 'adverb']

interface EntryRow {
  pos: string
  sense_num: number
  definition: string
  example: string | null
  synonyms: string | null
}

/** Lowercase, trim, and strip surrounding quotes/punctuation (keep inner ' and -). */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
}

/**
 * Candidate base forms for an inflected word, tried in order. Covers regular
 * plurals and verb tenses plus doubled-consonant participles (running→run).
 * Not exhaustive — irregulars are handled by the `lemmas` table instead.
 */
export function inflectionCandidates(w: string): string[] {
  const out: string[] = []
  const add = (s: string): void => {
    if (s.length >= 2 && s !== w && !out.includes(s)) out.push(s)
  }
  const rules: Array<[string, string]> = [
    ['ies', 'y'], // flies → fly
    ['ches', 'ch'],
    ['shes', 'sh'],
    ['sses', 'ss'],
    ['xes', 'x'],
    ['zes', 'z'],
    ['es', ''], // boxes → box
    ['s', ''], // cats → cat
    ['ied', 'y'], // tried → try
    ['ed', ''], // walked → walk
    ['ed', 'e'], // liked → like
    ['ing', ''], // reading → read
    ['ing', 'e'], // making → make
    ['er', ''], // faster → fast
    ['est', ''], // fastest → fast
    ['er', 'e'], // nicer → nice
    ['est', 'e'], // nicest → nice
  ]
  for (const [suf, rep] of rules) if (w.endsWith(suf)) add(w.slice(0, -suf.length) + rep)
  // Undo a doubled final consonant before -ing/-ed: running→run, stopped→stop.
  const doubled = w.match(/^(.*[aeiou])([bcdfghjklmnpqrstvwxyz])\2(ing|ed)$/)
  if (doubled) add(doubled[1] + doubled[2])
  return out
}

/** Rows for an exact headword, or [] — the single DB touch point. */
function rowsFor(word: string): EntryRow[] {
  const db = getDictionaryDb()
  if (!db) return []
  return db
    .prepare(
      'SELECT pos, sense_num, definition, example, synonyms FROM entries WHERE word = ? ORDER BY pos, sense_num',
    )
    .all(word) as EntryRow[]
}

/** Irregular-form lemmas from the `lemmas` table (geese→goose, went→go). */
function lemmaForms(word: string): string[] {
  const db = getDictionaryDb()
  if (!db) return []
  return (
    db.prepare('SELECT lemma FROM lemmas WHERE form = ?').all(word) as { lemma: string }[]
  ).map((r) => r.lemma)
}

/** Group flat rows into per-POS entries in stable order, capping senses. */
function shape(word: string, rows: EntryRow[]): DictionaryResult {
  const byPos = new Map<DictionaryPos, DictionarySense[]>()
  for (const r of rows) {
    const pos = POS_LABEL[r.pos]
    if (!pos) continue
    const senses = byPos.get(pos) ?? []
    if (senses.length >= MAX_SENSES_PER_POS) {
      byPos.set(pos, senses)
      continue
    }
    let synonyms: string[] = []
    if (r.synonyms) {
      try {
        synonyms = JSON.parse(r.synonyms) as string[]
      } catch {
        synonyms = []
      }
    }
    senses.push({
      definition: r.definition,
      ...(r.example ? { example: r.example } : {}),
      synonyms,
    })
    byPos.set(pos, senses)
  }
  const entries: DictionaryEntry[] = POS_ORDER.filter((p) => byPos.has(p)).map((pos) => ({
    pos,
    senses: byPos.get(pos) ?? [],
  }))
  return { word, found: entries.length > 0, entries }
}

/**
 * Resolve a definition for `raw`. Returns { found: false } for empty/oversized
 * input, an unknown word, or a missing dictionary asset — never throws.
 */
export function lookupWord(raw: string): DictionaryResult {
  const word = normalizeWord(raw)
  if (!word || word.length > MAX_INPUT) return { word, found: false, entries: [] }

  // 1) exact
  const exact = rowsFor(word)
  if (exact.length) return shape(word, exact)

  // 2) curated irregular lemma
  for (const lemma of lemmaForms(word)) {
    const rows = rowsFor(lemma)
    if (rows.length) return shape(lemma, rows)
  }

  // 3) rule-based inflection stripping
  for (const cand of inflectionCandidates(word)) {
    const rows = rowsFor(cand)
    if (rows.length) return shape(cand, rows)
  }

  return { word, found: false, entries: [] }
}
