// Build resources/dictionary/dictionary.db from the WordNet 3.1 database files
// shipped by the `wordnet-db` devDependency. Read-only reference asset consumed
// by electron/main/dictionary at runtime — see docs at the bottom of this file.
//
//   npm run build:dict
//
// Requires the Node-ABI better-sqlite3 (same as the DB test suites):
//   ./.gyp-venv/bin/pip install -q setuptools
//   PYTHON="$(pwd)/.gyp-venv/bin/python" npm run rebuild:node
// (restore Electron ABI afterwards with `npm run rebuild:electron`).
//
// Deterministic: rows are inserted in a fixed sort order and the file is
// VACUUMed, so re-running against the same WordNet + SQLite produces a
// byte-identical dictionary.db (no git churn on rebuild).

import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const wordnet = require('wordnet-db')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DICT_SRC = wordnet.path // node_modules/wordnet-db/dict
const OUT_DIR = join(ROOT, 'resources', 'dictionary')
const OUT_DB = join(OUT_DIR, 'dictionary.db')

// WordNet ss_type / index pos → our stored POS code. Adjective satellites ('s')
// collapse into plain adjectives.
const POS = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' }

/** Strip WordNet's lexical markers: `_`→space, drop trailing `(a)` sense hints. */
function cleanWord(w) {
  return w
    .replace(/\(.*?\)$/, '')
    .replace(/_/g, ' ')
    .trim()
}

/** Split a WordNet gloss ("definition; \"example\"; \"example\"") into parts. */
function parseGloss(gloss) {
  const defs = []
  const examples = []
  for (const raw of gloss.split(';')) {
    const p = raw.trim()
    if (!p) continue
    if (p.startsWith('"')) examples.push(p.replace(/^"+|"+$/g, '').trim())
    else defs.push(p)
  }
  return { definition: defs.join('; '), example: examples[0] ?? null }
}

/**
 * Parse a data.<pos> file into a Map keyed by 8-digit synset offset.
 * Each value: { words: string[], definition, example }.
 */
function parseData(file) {
  const synsets = new Map()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith(' ')) continue // license header + blank lines
    const barAt = line.indexOf(' | ')
    if (barAt === -1) continue
    const head = line.slice(0, barAt).trim().split(/\s+/)
    const gloss = line.slice(barAt + 3).trim()
    // head: offset lex_filenum ss_type w_cnt (word lex_id)*w_cnt p_cnt ...
    const offset = head[0]
    const wCnt = parseInt(head[3], 16)
    const words = []
    for (let i = 0; i < wCnt; i++) {
      const w = cleanWord(head[4 + i * 2])
      if (w) words.push(w)
    }
    synsets.set(offset, { words, ...parseGloss(gloss) })
  }
  return synsets
}

/**
 * Parse an index.<pos> file → array of { word, offsets[] } in file order.
 * Offsets are listed most-frequent-sense first (that ordering is our sense_num).
 */
function parseIndex(file) {
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith(' ')) continue
    const t = line.trim().split(/\s+/)
    // lemma pos synset_cnt p_cnt (ptr)*p_cnt sense_cnt tagsense_cnt (offset)*synset_cnt
    const word = cleanWord(t[0]).toLowerCase()
    const synsetCnt = parseInt(t[2], 10)
    const pCnt = parseInt(t[3], 10)
    const offsets = t.slice(4 + pCnt + 2) // skip pointers + sense_cnt + tagsense_cnt
    rows.push({ word, offsets: offsets.slice(0, synsetCnt) })
  }
  return rows
}

// The common English irregular inflections WordNet's rule-based Morphy can't
// recover on its own (the *.exc exception files aren't shipped by wordnet-db).
// Kept small and high-frequency — enough that a reader selecting "geese" or
// "children" still resolves. form → base lemma.
const IRREGULARS = {
  children: 'child',
  men: 'man',
  women: 'woman',
  people: 'person',
  feet: 'foot',
  teeth: 'tooth',
  geese: 'goose',
  mice: 'mouse',
  lice: 'louse',
  oxen: 'ox',
  knives: 'knife',
  wolves: 'wolf',
  lives: 'life',
  leaves: 'leaf',
  halves: 'half',
  loaves: 'loaf',
  selves: 'self',
  wives: 'wife',
  thieves: 'thief',
  went: 'go',
  gone: 'go',
  was: 'be',
  were: 'be',
  been: 'be',
  am: 'be',
  is: 'be',
  are: 'be',
  had: 'have',
  has: 'have',
  did: 'do',
  done: 'do',
  made: 'make',
  said: 'say',
  took: 'take',
  taken: 'take',
  came: 'come',
  saw: 'see',
  seen: 'see',
  gave: 'give',
  given: 'give',
  found: 'find',
  thought: 'think',
  brought: 'bring',
  bought: 'buy',
  caught: 'catch',
  taught: 'teach',
  ran: 'run',
  ate: 'eat',
  eaten: 'eat',
  fell: 'fall',
  fallen: 'fall',
  drew: 'draw',
  drawn: 'draw',
  flew: 'fly',
  flown: 'fly',
  grew: 'grow',
  grown: 'grow',
  knew: 'know',
  known: 'know',
  threw: 'throw',
  thrown: 'throw',
  wrote: 'write',
  written: 'write',
  spoke: 'speak',
  spoken: 'speak',
  broke: 'break',
  broken: 'break',
  chose: 'choose',
  chosen: 'choose',
  froze: 'freeze',
  frozen: 'freeze',
  stole: 'steal',
  stolen: 'steal',
  better: 'good',
  best: 'good',
  worse: 'bad',
  worst: 'bad',
}

function build() {
  console.log(`WordNet source: ${DICT_SRC}`)
  mkdirSync(OUT_DIR, { recursive: true })
  if (existsSync(OUT_DB)) rmSync(OUT_DB)

  const db = new Database(OUT_DB)
  db.pragma('journal_mode = OFF')
  db.pragma('synchronous = OFF')
  db.exec(`
    CREATE TABLE entries (
      word       TEXT NOT NULL,
      pos        TEXT NOT NULL,
      sense_num  INTEGER NOT NULL,
      definition TEXT NOT NULL,
      example    TEXT,
      synonyms   TEXT
    );
    CREATE TABLE lemmas (
      form  TEXT NOT NULL,
      lemma TEXT NOT NULL
    );
  `)

  const rows = [] // collect then sort for deterministic insert order
  for (const [name, pos] of Object.entries(POS)) {
    const synsets = parseData(join(DICT_SRC, `data.${name}`))
    const index = parseIndex(join(DICT_SRC, `index.${name}`))
    for (const { word, offsets } of index) {
      offsets.forEach((offset, i) => {
        const syn = synsets.get(offset)
        if (!syn || !syn.definition) return
        const synonyms = syn.words.filter((w) => w.toLowerCase() !== word)
        rows.push([
          word,
          pos,
          i + 1,
          syn.definition,
          syn.example,
          synonyms.length ? JSON.stringify(synonyms) : null,
        ])
      })
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2] - b[2])

  const insertEntry = db.prepare(
    'INSERT INTO entries (word, pos, sense_num, definition, example, synonyms) VALUES (?,?,?,?,?,?)',
  )
  const insertLemma = db.prepare('INSERT INTO lemmas (form, lemma) VALUES (?,?)')
  db.transaction(() => {
    for (const r of rows) insertEntry.run(...r)
    for (const form of Object.keys(IRREGULARS).sort()) insertLemma.run(form, IRREGULARS[form])
  })()

  db.exec('CREATE INDEX idx_entries_word ON entries(word)')
  db.exec('CREATE INDEX idx_lemmas_form ON lemmas(form)')
  db.exec('VACUUM')
  const entryCount = db.prepare('SELECT COUNT(*) n FROM entries').get().n
  const wordCount = db.prepare('SELECT COUNT(DISTINCT word) n FROM entries').get().n
  db.close()

  console.log(
    `entries: ${entryCount}  distinct words: ${wordCount}  irregulars: ${Object.keys(IRREGULARS).length}`,
  )
  console.log(`wrote ${OUT_DB}`)
}

build()
