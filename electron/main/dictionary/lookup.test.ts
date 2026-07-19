import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { __setDictionaryDb } from './db'
import { lookupWord, normalizeWord, inflectionCandidates } from './lookup'

// Exercises the lookup resolution logic against a tiny hand-built in-memory
// dictionary (real better-sqlite3, Node ABI — no bundled asset). Covers exact
// match, the irregular-lemma table, rule-based inflection stripping, POS
// grouping/synonym parsing, and the graceful miss paths.

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE entries (
      word TEXT, pos TEXT, sense_num INTEGER, definition TEXT, example TEXT, synonyms TEXT
    );
    CREATE TABLE lemmas (form TEXT, lemma TEXT);
  `)
  const e = db.prepare(
    'INSERT INTO entries (word,pos,sense_num,definition,example,synonyms) VALUES (?,?,?,?,?,?)',
  )
  // "book": a noun sense (with example + synonym) and a verb sense.
  e.run('book', 'n', 1, 'a written work', 'a good book', JSON.stringify(['volume']))
  e.run('book', 'v', 1, 'reserve in advance', null, null)
  // "goose": target of the irregular "geese".
  e.run('goose', 'n', 1, 'a web-footed bird', null, null)
  // "run": target of rule-based "running".
  e.run('run', 'v', 1, 'move fast on foot', null, null)
  // "cat": target of plural "cats".
  e.run('cat', 'n', 1, 'a small feline', null, null)
  db.prepare('INSERT INTO lemmas (form,lemma) VALUES (?,?)').run('geese', 'goose')
  __setDictionaryDb(db)
})

afterAll(() => {
  __setDictionaryDb(null)
  db.close()
})

describe('normalizeWord', () => {
  it('lowercases, trims, and strips surrounding punctuation', () => {
    expect(normalizeWord('  “Book!” ')).toBe('book')
    expect(normalizeWord("don't")).toBe("don't") // keeps inner apostrophe
  })
})

describe('inflectionCandidates', () => {
  it('undoes doubled-consonant participles', () => {
    expect(inflectionCandidates('running')).toContain('run')
    expect(inflectionCandidates('stopped')).toContain('stop')
  })
  it('handles regular plurals and -ies', () => {
    expect(inflectionCandidates('cats')).toContain('cat')
    expect(inflectionCandidates('flies')).toContain('fly')
  })
})

describe('lookupWord', () => {
  it('returns an exact match grouped by POS in noun→verb order', () => {
    const r = lookupWord('book')
    expect(r.found).toBe(true)
    expect(r.word).toBe('book')
    expect(r.entries.map((e) => e.pos)).toEqual(['noun', 'verb'])
    const noun = r.entries[0].senses[0]
    expect(noun.definition).toBe('a written work')
    expect(noun.example).toBe('a good book')
    expect(noun.synonyms).toEqual(['volume'])
  })

  it('is case- and punctuation-insensitive', () => {
    expect(lookupWord('  Book. ').found).toBe(true)
  })

  it('resolves an irregular plural via the lemma table', () => {
    const r = lookupWord('geese')
    expect(r.found).toBe(true)
    expect(r.word).toBe('goose')
  })

  it('resolves a regular plural via inflection rules', () => {
    const r = lookupWord('cats')
    expect(r.found).toBe(true)
    expect(r.word).toBe('cat')
  })

  it('resolves a doubled-consonant participle', () => {
    const r = lookupWord('running')
    expect(r.found).toBe(true)
    expect(r.word).toBe('run')
  })

  it('returns not-found for an unknown word', () => {
    expect(lookupWord('zzxqty').found).toBe(false)
  })

  it('returns not-found for empty or oversized input without touching the DB', () => {
    expect(lookupWord('   ').found).toBe(false)
    expect(lookupWord('a'.repeat(61)).found).toBe(false)
  })

  it('degrades to not-found when the dictionary asset is missing', () => {
    __setDictionaryDb(null)
    expect(lookupWord('book').found).toBe(false)
    __setDictionaryDb(db) // restore for any later tests
  })
})
