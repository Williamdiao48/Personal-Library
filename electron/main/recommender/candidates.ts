import { get, run, isDbOpen } from '../db'
import type { SeedQuery } from './seedQueries'
import { readCandidateCache, writeCandidateCache } from './candidateCache'
import { dedupeSubjects } from './subjectNormalize'
import { now as timingNow, logTiming } from './timing'

// C4.3 — OpenLibrary candidate generation (§9 step 1). Turn seed queries into a
// deduplicated set of real books: hit `search.json` (free, no key), normalize
// each doc to the shape the rerank needs, and cache raw payloads by query with a
// TTL (candidate_cache, migration 20) so repeat recommend() calls don't re-hit
// their API. Only the cache read/write and the network call touch the outside
// world — the normalizer is pure. Subjects-only in v1 (D-C4-2): no per-work
// description fetch.

const OPENLIBRARY_ORIGIN = 'https://openlibrary.org'
const OPENLIBRARY_SEARCH = `${OPENLIBRARY_ORIGIN}/search.json`
// Fields we ask OpenLibrary for — subjects included so a single call yields the
// candidate's embed text (title/author/subjects); no N+1 works fetch (D-C4-2).
// `language` gates non-English editions; `readinglog_count`/`ratings_count`/
// `edition_count` are the popularity signal (Goodreads-grade, but native + free) that
// leads the feed toward grounded, well-read books instead of deep-catalogue obscurities.
const FIELDS =
  'key,title,author_name,subject,cover_i,isbn,number_of_pages_median,language,readinglog_count,ratings_count,edition_count'
// Sort the seed results by readership so each subject returns its WELL-READ books first
// (subject:"Dystopias" → 1984 / Hunger Games / Brave New World, not obscure exact matches).
// The taste rerank + a jittered popularity prior refine within this grounded pool. Folded
// into the cache key so stale relevance-sorted rows don't serve.
const SORT = 'readinglog'
// Server-side language filter: restrict to works that HAVE an English edition, so the
// foreign-ONLY long tail (Polish dictionaries, untranslated works) never enters the pool.
// This is the coarse gate; it does NOT catch a translated work whose CANONICAL title stays
// in the original language (the Witcher's "Wieża jaskółki" has an English edition, so it
// passes) — that's the foreign-TITLE reject in normalizeOpenLibraryDoc. Folded into the
// cache key. (2026-08-26.)
const LANGUAGE = 'eng'
// OpenLibrary asks clients to send a descriptive User-Agent identifying the app.
const OL_HEADERS = {
  'User-Agent': 'PersonalLibrary/0.5 (personal reading app; recommender)',
  Accept: 'application/json',
}

export interface CandidatesConfig {
  MAX_SUBJECTS_PER_DOC: number
  LIMIT_PER_QUERY: number
  MAX_CANDIDATES: number
  CACHE_TTL_MS: number
  SOFT_FLOOR_MS: number
  FETCH_TIMEOUT_MS: number
  CONCURRENCY: number
  DESCRIPTION_CONCURRENCY: number
  DESCRIPTION_CACHE_TTL_MS: number
}

export const CANDIDATES: CandidatesConfig = {
  MAX_SUBJECTS_PER_DOC: 8, // cap the subjects folded into a candidate's embed text
  LIMIT_PER_QUERY: 40, // docs requested per seed query (deeper than the original 20 so
  // the Discover Books filter has more to page through before it exhausts)
  MAX_CANDIDATES: 200, // cap the merged/deduped book pool. Raised from 80: with a
  // Books-only Discover filter a reader can scroll the whole pool, and 80 exhausted in
  // one session. Candidate vectors are cached by sourceId, so the deeper pool only
  // costs a one-time embed of the extra books, not every refresh.
  CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days — hard ceiling on the search cache
  SOFT_FLOOR_MS: 2 * 60 * 60 * 1000, // 2 h — a Refresh re-queries once search results are older than this
  FETCH_TIMEOUT_MS: 15_000,
  CONCURRENCY: 4, // in-flight OpenLibrary queries (robust API, same host)
  DESCRIPTION_CONCURRENCY: 4, // in-flight per-work description fetches (same host as search)
  DESCRIPTION_CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days — descriptions change rarely
}

/** Which generator produced a candidate — books vs. the fanfic sources. */
export type SourceName = 'book' | 'ao3' | 'ffn'

// Bumped whenever the *text* we embed for a candidate changes shape. v2 folded the
// fic summary into the metadata string; v3 folds the book description too (the
// OpenLibrary N+1 works fetch). Threaded into both cache keys — `candidate_cache`
// (the parsed Candidate[] keys) and `candidate_embeddings` (the model_version) — so
// a recipe change invalidates stale entries instead of re-issuing a shared-DB
// migration (branches collide on migration numbers). Old rows orphan harmlessly and
// age out. (The per-work `oldesc:` description cache is deliberately NOT versioned:
// a work's description is recipe-independent, so a future bump must not force
// re-fetching descriptions that didn't change.)
export const CANDIDATE_TEXT_VERSION = 3

/**
 * A normalized recommendation candidate — the same content-only shape the rerank
 * embeds, whether it's an OpenLibrary book or an AO3/FFN fic. For fics, `subjects`
 * carries the work's native tags (so it embeds exactly like a book's subjects) and
 * `isbn` is null. `description` is a fic's summary/blurb (books: null — OpenLibrary
 * `search.json` carries no blurb), folded into the embed text as a content signal.
 */
export interface Candidate {
  title: string
  author: string | null
  subjects: string[]
  coverUrl: string | null
  /** OpenLibrary work key (`/works/OL45804W`) or a fic's work URL; the dedup identity. */
  sourceId: string
  isbn: string | null
  /** A fic's summary/blurb (already in the scraped results page); null for books. */
  description: string | null
  /** The generator that produced this candidate (dedup namespacing, display, diversity). */
  source: SourceName
  /** Readership signal (OpenLibrary `readinglog_count`) that feeds the popularity prior;
   *  absent for fics and for any book OpenLibrary didn't return the count for (prior off). */
  popularity?: number
  /** Median page count (OpenLibrary `number_of_pages_median`); absent for fics and for any
   *  book OpenLibrary returned no count for. Exploration requires a KNOWN substantive length
   *  (the exploit path doesn't), so a no-page-count picture book can't win an explore slot. */
  pages?: number
}

/** The subset of an OpenLibrary `search.json` doc we read (all fields optional). */
export interface OpenLibraryDoc {
  key?: string
  title?: string
  author_name?: string[]
  subject?: string[]
  cover_i?: number
  isbn?: string[]
  /** Median page count across editions — the substantive-length signal (see
   * MIN_SUBSTANTIVE_PAGES). Absent for many docs, so only ever used to *reject*. */
  number_of_pages_median?: number
  /** ISO 639-2 language codes across editions (e.g. `['eng','spa']`); gates non-English. */
  language?: string[]
  /** Readers who logged the work on OpenLibrary — the primary popularity signal. */
  readinglog_count?: number
  /** Number of ratings — a secondary footprint signal (part of the obscurity floor). */
  ratings_count?: number
  /** Distinct editions — a book widely published across many editions is established;
   *  1 (or absent) with no readers/ratings is the vanity/obscure long tail. */
  edition_count?: number
}

/** Build a cover image URL from OpenLibrary's numeric cover id, or null. */
export function coverUrlFromId(coverId: number | undefined): string | null {
  return typeof coverId === 'number' ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null
}

/** Lowercase, strip punctuation, collapse whitespace — for tolerant title/author matching. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The normalized dedup identity for a book/fic: `title|author`, lowercased with
 * punctuation stripped and whitespace collapsed (exact-normalized, no fuzzy match).
 * Shared by the library/dismissed set builders, cross-source union, and
 * `filterCandidates` so every side normalizes identically.
 */
export function candidateKey(title: string, author: string | null): string {
  return `${norm(title)}|${norm(author ?? '')}`
}

// Stopwords + file-format/URL noise stripped before the fuzzy owned-book dedup, so a
// filename-style title ("_OceanofPDF.com_Elantris_-_Brandon_Sanderson", author NULL)
// collapses to its real content tokens {elantris, brandon, sanderson}. Deliberately
// KEEPS real title words (new/final/edited/book) so containment isn't over-loosened.
const TITLE_NOISE = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'for',
  'with',
  'by',
  'at',
  'from',
  'oceanofpdf',
  'com',
  'www',
  'http',
  'https',
  'pdf',
  'epub',
  'mobi',
  'azw3',
  'ebook',
])

/**
 * Distinctive content tokens of a title (+author) string for the fuzzy owned-book dedup:
 * normalized, split on whitespace, with stopwords + file-format noise removed. Pure.
 * Shared by the snapshot builder (owned side) and `filterCandidates` (candidate side) so
 * both normalize identically.
 */
export function contentTokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length > 0 && !TITLE_NOISE.has(t))
}

// Graphic novel / comic / manga — content this text-first reader can't render
// (image-heavy panels). Targeted patterns (not a bare "comics") so a text novel that
// merely *mentions* comics isn't dropped. Matches OpenLibrary's usual tags: "Comics &
// graphic novels", "Graphic novels", "Comic books, strips, etc.", "Manga". Checked
// against BOTH title and subjects — the Wings-of-Fire adaptation "The hidden kingdom
// [graphic novel]" carries NO comic subject tag (just "Dragons, fiction"/"Fantasy
// fiction") but announces itself in the title (leaked into normal recs 2026-08-26).
const GRAPHIC_NOVEL_RE =
  /graphic novel|comic book|comics\s*&\s*graphic|comics,\s*strips|\bmanga\b|cartoons and comics/i

// A book shorter than this (OpenLibrary median page count) is a picture book, board
// book, or early/beginning reader — not substantive reading for this adult prose +
// MG/YA-novel reader. This is the ONLY reliable separator for the hardest leak class:
// children's books about the SAME topics the reader likes. "Big Brown Bear" (24–48 pp,
// subjects "Bears"/"Juvenile fiction") is subject-for-subject indistinguishable from the
// owned Seekers novels (320 pp, "Bears"/"Juvenile fiction") — only LENGTH tells them
// apart. A substantive-length gate, not a topic/franchise ban; picture/board/early
// readers run 24–64 pp, chapter books start ~80, MG novels 150+ (Seekers 320, Warriors
// 295–336 clear it by a mile), so 65 cuts the young tier without touching real novels or
// even slim novellas (~100+). Applied ONLY when the count is present — it's absent for
// many docs, so it can only ever reject, never gate-keep the whole pool. (2026-08-26.)
const MIN_SUBSTANTIVE_PAGES = 65

// Non-readable franchise merchandise that OpenLibrary lists as "books": poster /
// coloring / sticker / activity books, postcard sets, sketchbooks, plus collectible
// reference (collector's handbooks/guides, price guides). A text-first reader can't
// read these — and because the reader owns the *novels* but never the merch, this junk
// sits in an under-observed embedding region the exploration picker (UCB-lite = prefer
// under-observed) then loves (uncertainty ≠ quality: surfaced 4 Harry Potter poster
// books, then an HP collector's handbook, into the explore slots on 2026-08-26).
// Reject at the source so it never reaches the pool — cleans BOTH the exploit feed and
// the explore tail. Matched on title (these self-advertise their format) AND subjects;
// targeted phrases (the format word + "book"/"collection"/"guide", not a bare
// "poster"/"activity") so a real novel with an adjacent word isn't dropped.
const MERCHANDISE_RE =
  /\bposter book|colou?ring book|sticker book|activity book|postcard book|\bsketchbook\b|poster collection|sticker collection|postcard collection|collector'?s? handbook|collector'?s? guide|price guide|cinematic guide|movie guide|film companion|visual companion|unofficial guide|official guide|\bscrapbook\b/i

// Non-fiction ABOUT a franchise/topic, which subject-seeded queries drag in wholesale:
// a `subject:"Harry Potter"` seed returns literary criticism ("Looking for God in Harry
// Potter" → "History and criticism", "Religion in literature"), fandom miscellanea ("We
// love Harry Potter!" → "Handbooks, manuals"), and companion references — all of which
// the embedder scores HIGH (the title says "Harry Potter") so they win normal exploit
// slots, not just explore. And OpenLibrary's subject search STEMS: a `subject:"Bears"`
// seed (from the reader's Seekers series) matches "Bearings (Machinery)", dragging in
// engineering manuals. This is a content-TYPE gate — books ABOUT literature/a-topic vs.
// prose fiction — NOT a franchise-keyword ban: the reader's real HP novels carry
// "Fantasy fiction"/"Wizards" but NONE of these markers, so novels pass and commentary
// doesn't. Markers chosen from real fetched metadata (2026-08-26); deliberately NOT
// "Literary theory"/"English literature"/"Literature", which OpenLibrary's messy
// edition-merge also pins on the genuine novels. Checked against title AND subjects.
const NONFICTION_SUBJECT_RE =
  /criticism and interpretation|history and criticism|\bcriticism\b|\bin literature\b|religious aspects|\bmiscellanea\b|\bconcordance|encyclopedi|handbooks?,?\s*manuals?|\bengineering\b|\bmachinery\b|ball[- ]?bearings?|roller bearings?|study guide|teacher'?s? guide/i

// Young-children reading formats — picture books, board books, nursery rhymes, and
// early/beginning ("easy") readers — that aren't substantive reading for this adult
// prose reader. Exploration reaches for these because the reader owns NOTHING like them
// (a genuinely under-observed region → high uncertainty), so the abundance fix can't
// help; this is an audience gate at the source, a sibling of the graphic-novel reject.
// Leaked "Teddy Bear, Teddy Bear" (nursery rhyme) then "Lost in Little Bear's Room"
// (Minarik early reader, tagged "Picture books" + "Juvenile Easy Readers") on 2026-08-26.
// Targeted to the young-tier FORMAT tags only — deliberately NOT "Juvenile fiction" /
// "Children's fiction" / "Children's stories", which also tag the real MG/YA novels the
// reader owns (Harry Potter et al.). Matched on title and the full subject list. OL's
// numeric audience tags ("age:max:8", "grade:max:2") would be a more principled gate but
// are inconsistently present — a documented follow-up.
// "Stories in rhyme" is included: it's an almost-exclusive picture-book marker (adult/MG
// prose isn't in rhyme) and catches the young-tier books that carry NO page count for the
// length gate to act on ("Big brown bear =" — null pages, subjects incl. "Stories in rhyme").
const JUVENILE_FORMAT_RE =
  /\bnursery rhyme|\bboard book|\bpicture book|\beasy reader|\bearly reader|\bbeginning reader|\breaders?\s*[-/]\s*beginner|stories in rhyme/i

// A displayed TITLE is foreign when it uses a non-Latin script (Cyrillic / Greek / CJK /
// Arabic / Hebrew / Thai / Devanagari / Hangul) or Latin diacritics essentially absent
// from English titles (Polish ł/ż/ą/ę/ś/ć/ń/ź, Czech ř/ů/ě, Slavic/Baltic š/č/ž/đ, Turkish
// ı/ğ/ş, Hungarian ő/ű, German ß). OpenLibrary shows a work's CANONICAL title, which for a
// translated work stays in the original language even when English editions exist (so the
// language field / the server language=eng filter both pass it — the Witcher's "Wieża
// jaskółki") — the title itself is the only signal. English loan-diacritics (café / naïve /
// Brontë / Les Misérables: é/è/ë/ï/ñ/ü/ö/ä/ç/à/â/ô/î/û/å) are deliberately EXCLUDED so real
// English titles and accented names pass — high precision over recall (an ASCII foreign
// title like "Pani Jeziora" is an accepted residual). (2026-08-26.)
// Ranges are written as \u escapes (not literal boundary glyphs) for legibility.
// Greek, Cyrillic, Hebrew, Arabic, Devanagari, Thai, Kana, CJK, Hangul. The
// Hebrew/Arabic blocks include combining marks, so `no-misleading-character-class`
// flags the class \u2014 intended: we match ANY char in these scripts, marks included.
// prettier-ignore
// eslint-disable-next-line no-misleading-character-class
const NON_LATIN_SCRIPT_RE = /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u
const FOREIGN_LATIN_RE = /[łŁżŻśŚćĆńŃąĄęĘźŹřŘůŮěĚšŠčČžŽđĐığĞşŞőŐűŰß]/

// Function words from Spanish / French / German / Italian / Portuguese that essentially
// never appear in English titles (articles, prepositions, conjunctions). A pure-ASCII
// foreign title carries no diacritic signal ("Una corte de niebla y furia" — the Spanish
// edition of A Court of Mist and Fury, which OpenLibrary shows because that translation is
// its most-read edition), so the script/diacritic gates miss it — the function words are
// the only tell. Requiring ≥2 DISTINCT hits keeps precision high: a lone article in an
// English title ("La La Land", "El Deafo", "Le Morte d'Arthur") never trips it. (2026-08-26.)
const FOREIGN_FUNCTION_WORDS = new Set([
  // articles
  'el',
  'la',
  'los',
  'las',
  'le',
  'les',
  'il',
  'lo',
  'gli',
  'un',
  'una',
  'uno',
  'unos',
  'unas',
  'une',
  'uma',
  // prepositions / conjunctions
  'de',
  'del',
  'des',
  'du',
  'dos',
  'das',
  'der',
  'die',
  'den',
  'dem',
  'y',
  'et',
  'und',
  'con',
  'por',
  'para',
  'avec',
  'pour',
  'dans',
  'mit',
  'von',
  'für',
  'fur',
  'que',
  'qui',
  'che',
  'nel',
  'nella',
  'zur',
  'zum',
  'aux',
  'ao',
  'em',
])

/** True when a displayed title reads as non-English by function-word signal: ≥2 distinct
 *  Romance/German function words. Catches ASCII foreign titles the script/diacritic gates
 *  can't; high precision (a single stray article is ignored). Pure. */
export function looksNonEnglishTitle(title: string): boolean {
  const hits = new Set(
    title
      .toLowerCase()
      .split(/[^a-zà-öø-ÿ]+/)
      .filter((t) => FOREIGN_FUNCTION_WORDS.has(t)),
  )
  return hits.size >= 2
}

/**
 * True when a book's fetched DESCRIPTION reads as non-English — the German-blurb leak the
 * title gate can't see (a sparse or English-looking title, but a blurb that is entirely
 * German: "Die junge Elfe ... in einer Welt voller ..."). A non-Latin script anywhere, or
 * ≥3 DISTINCT foreign function words. The threshold is one higher than the title gate's
 * because the blurb is long enough that an English one could carry one or two foreign words
 * by chance (a quoted foreign title, a loanword) — three distinct articles/prepositions is a
 * decisive non-English signal. Empty/absent description ⇒ false (no signal). Pure.
 */
export function looksNonEnglishDescription(description: string | null | undefined): boolean {
  if (!description) return false
  if (NON_LATIN_SCRIPT_RE.test(description)) return true
  const hits = new Set(
    description
      .toLowerCase()
      .split(/[^a-zà-öø-ÿ]+/)
      .filter((t) => FOREIGN_FUNCTION_WORDS.has(t)),
  )
  return hits.size >= 3
}

// Juvenile-AUDIENCE subjects (as opposed to the young-tier FORMAT tags in JUVENILE_FORMAT_RE).
// These alone can't reject — real MG/YA novels the reader owns (Harry Potter, Seekers,
// Warriors) all carry "Juvenile fiction" / "Children's fiction" too. They gate a book ONLY
// in combination with the absence of BOTH a substantive length AND a fiction-genre subject
// (see the reject in normalizeOpenLibraryDoc): that tight profile is the picture/activity
// book with no page count and no genre ("Acorns everywhere!", "The Berenstain Bears grow-it"
// — Bears/Juvenile-fiction, no pages, no Fantasy/Adventure) that leaked into the explore
// slots, while every owned-class MG novel is saved by its page count (295–320) or its genre
// tag. (2026-08-26.)
const JUVENILE_AUDIENCE_RE =
  /juvenile fiction|juvenile literature|juvenile nonfiction|juvenile works|juvenile audience|children.?s fiction|children.?s stories|children.?s literature/i
// Fiction-genre markers typical of the MG/YA & adult novels the reader actually reads. A
// juvenile-audience book carrying one of these is a real novel (kept); one carrying none —
// and no page count — is the picture/activity-book profile. Deliberately does NOT match a
// bare "Fiction" (both leaked junk books carry "Fiction").
const FICTION_GENRE_RE =
  /fantasy|science fiction|\bsci-?fi\b|dystopi|adventure|mystery|thriller|romance|\bhorror\b|historical fiction|mytholog|fairy tale|fairies|supernatural|paranormal|\bmagic|dragons?|wizard|vampire|superhero/i

// Positive fiction signal — a POSITIVE gate for EXPLORE eligibility only. The nonfiction
// gates above are targeted blocklists (criticism, engineering, film companions); by
// construction they can't catch nonfiction on an ARBITRARY novel topic (a seed-science
// textbook → "Seeds"/"Agriculture"; an art-of/making-of → film subjects), which is exactly
// what exploration's novelty reward drags up. So explore additionally REQUIRES a positive
// fiction marker: a subject tagged "… fiction" (\bfiction\b — note this does NOT match
// "nonfiction", no word boundary) or a narrative genre. Film/TV companion books are excluded
// even though they carry a genre word ("Science fiction films"), because a book ABOUT a film
// is nonfiction. Title + subjects. Used by pickExplorePicks ONLY, so the (satisfactory)
// exploit feed stays byte-identical. (2026-08-27.)
const FICTION_SUBJECT_RE = /\bfiction\b/i
const FILM_FORM_RE =
  /motion pictures?|\bfilms?\b|\bcinema|filmmaking|screenplays?|television (?:series|programs?)/i
export function looksLikeFiction(title: string, subjects: string[]): boolean {
  if (FILM_FORM_RE.test(title) || subjects.some((s) => FILM_FORM_RE.test(s))) return false
  return subjects.some((s) => FICTION_SUBJECT_RE.test(s) || FICTION_GENRE_RE.test(s))
}

// Placeholder / incomplete titles OpenLibrary carries for unpublished or catalog-stub works
// ("Untitled Sanderson 3 of 3", "Unknown title") — junk from the data source, not a real book
// the reader could open. A word-boundary match so a genuine title merely CONTAINING these as
// substrings is safe. (2026-08-27.)
const PLACEHOLDER_TITLE_RE = /\buntitled\b|\bunknown title\b|\bno title\b|\buntitled work\b/i

/**
 * Normalize one `search.json` doc → Candidate, or null when it has no usable
 * title. Tolerates every field being absent (OpenLibrary omits them freely).
 * `sourceId` falls back to a synthetic title|author key when the work key is
 * missing, so dedup still works.
 */
export function normalizeOpenLibraryDoc(
  doc: OpenLibraryDoc,
  cfg: { MAX_SUBJECTS_PER_DOC: number } = CANDIDATES,
): Candidate | null {
  const title = doc.title?.trim()
  if (!title) return null
  // Reject OpenLibrary placeholder/stub titles ("Untitled Sanderson 3 of 3") — data-source junk.
  if (PLACEHOLDER_TITLE_RE.test(title)) return null
  // Reject foreign-titled works (the "different languages" leak): a non-Latin script or
  // strongly-non-English Latin diacritics in the DISPLAYED title, OR a pure-ASCII foreign
  // title caught by function words (≥2 Romance/German articles/prepositions — "Una corte de
  // niebla y furia"). Catches translated works OpenLibrary lists under their original-language
  // canonical title even though an English edition exists (so the language gate below can't).
  if (
    NON_LATIN_SCRIPT_RE.test(title) ||
    FOREIGN_LATIN_RE.test(title) ||
    looksNonEnglishTitle(title)
  )
    return null
  // Reject graphic novels / comics / manga at the source. Check the TITLE and the FULL
  // subject list (before the MAX_SUBJECTS cap) — a late-listed tag isn't missed, and an
  // adaptation that tags itself only in the title ("… [graphic novel]") is still caught.
  const subjects_ = doc.subject ?? []
  if (GRAPHIC_NOVEL_RE.test(title) || subjects_.some((s) => GRAPHIC_NOVEL_RE.test(s))) return null
  // Reject sub-substantive lengths (picture / board / early-reader) by median page count —
  // the one signal that separates a children's book from an MG/YA novel on the SAME topic
  // (see MIN_SUBSTANTIVE_PAGES). Only when the count is present; absent ⇒ fall through to
  // the subject/format markers below.
  if (
    typeof doc.number_of_pages_median === 'number' &&
    doc.number_of_pages_median > 0 &&
    doc.number_of_pages_median < MIN_SUBSTANTIVE_PAGES
  )
    return null
  // Reject non-readable franchise merchandise (poster/coloring/etc. + collectible
  // reference) and pre-reader children's formats (nursery rhymes / board books). Check
  // the title AND the full subject list — either self-identifies the format.
  if (MERCHANDISE_RE.test(title) || subjects_.some((s) => MERCHANDISE_RE.test(s))) return null
  if (JUVENILE_FORMAT_RE.test(title) || subjects_.some((s) => JUVENILE_FORMAT_RE.test(s)))
    return null
  // Reject the picture/activity-book profile that only the young-tier FORMAT tags miss: a
  // juvenile-AUDIENCE subject with NEITHER a substantive page count NOR a fiction-genre
  // subject ("Acorns everywhere!" / "The Berenstain Bears grow-it" — Bears + Juvenile
  // fiction, no pages, no genre; leaked into the explore slots 2026-08-26). Owned-class MG
  // novels are spared by their page count (295–320) or their genre tag (Fantasy/Adventure).
  const pages = doc.number_of_pages_median
  const substantiveLength = typeof pages === 'number' && pages >= MIN_SUBSTANTIVE_PAGES
  if (
    !substantiveLength &&
    subjects_.some((s) => JUVENILE_AUDIENCE_RE.test(s)) &&
    !subjects_.some((s) => FICTION_GENRE_RE.test(s))
  )
    return null
  // Reject non-fiction commentary/reference/technical works (books ABOUT a topic, dragged
  // in by broad subject seeds) — content-type gate, not a keyword ban (see the regex).
  if (NONFICTION_SUBJECT_RE.test(title) || subjects_.some((s) => NONFICTION_SUBJECT_RE.test(s)))
    return null
  // Reject non-English editions (the "Polish book" leak). Only when a language list is
  // present AND lacks `eng` — a missing list is kept (OpenLibrary omits it freely; the
  // dominant library is English, so absence ⇒ benefit of the doubt).
  if (Array.isArray(doc.language) && doc.language.length > 0 && !doc.language.includes('eng'))
    return null
  // Obscurity floor: drop the zero-footprint long tail — ≤1 edition AND no readers AND no
  // ratings — where the genuinely strange self-published/vanity items live. Guarded on
  // HAVING a signal (any of the three present) so absent-metadata docs / test fixtures fall
  // through untouched; the popularity prior downstream does the softer grounding.
  const hasFootprint =
    doc.edition_count !== undefined ||
    doc.readinglog_count !== undefined ||
    doc.ratings_count !== undefined
  if (
    hasFootprint &&
    (doc.edition_count ?? 0) <= 1 &&
    (doc.readinglog_count ?? 0) === 0 &&
    (doc.ratings_count ?? 0) === 0
  )
    return null
  const author = doc.author_name?.[0]?.trim() || null
  // Collapse subject-variant duplicates ("Bears" + "Bears, Fiction" → one "Bears")
  // BEFORE the MAX_SUBJECTS cap, so the topic isn't double-counted in the embed text
  // and the cap spends its budget on distinct topics (see subjectNormalize.ts).
  const subjects = dedupeSubjects(doc.subject ?? []).slice(0, cfg.MAX_SUBJECTS_PER_DOC)
  const sourceId =
    doc.key?.trim() || `synthetic:${title.toLowerCase()}|${(author ?? '').toLowerCase()}`
  return {
    title,
    author,
    subjects,
    coverUrl: coverUrlFromId(doc.cover_i),
    sourceId,
    isbn: doc.isbn?.[0]?.trim() || null,
    description: null, // search.json has no blurb; book descriptions are a deferred N+1 tier
    source: 'book',
    ...(typeof doc.readinglog_count === 'number' ? { popularity: doc.readinglog_count } : {}),
    ...(typeof doc.number_of_pages_median === 'number'
      ? { pages: doc.number_of_pages_median }
      : {}),
  }
}

// ── book descriptions (the OpenLibrary N+1) ────────────────────────────────────
// `search.json` carries no blurb, so a book's description comes from its own work
// JSON (`/works/OL…W.json`). Folding it into the embed text separates books that
// share subjects by plot/tone — the same content signal fics get from their summary
// (tier 1). The parse helpers are pure; only fetchWorkDescription touches the
// network + cache.

/**
 * OpenLibrary work descriptions are markdown-ish and frequently carry a trailing
 * source-attribution block: a `----------` separator line then `[n]: http…` link
 * definitions. Cut everything from the first separator line, drop any leftover
 * bracketed link-definition lines, and collapse whitespace. Empty → null. Pure.
 */
export function cleanOlDescription(raw: string | null | undefined): string | null {
  if (!raw) return null
  const beforeSeparator = raw.split(/\n\s*-{3,}/)[0]
  const cleaned = beforeSeparator
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[[^\]]+\]:\s*http/i.test(line)) // markdown link definitions
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || null
}

/**
 * Pull the description out of an OpenLibrary work JSON: it's either a plain string
 * or a `{ type: '/type/text', value }` object, or absent. Cleaned via
 * cleanOlDescription. Pure.
 */
export function extractOlDescription(json: unknown): string | null {
  const d = (json as { description?: unknown } | null)?.description
  if (typeof d === 'string') return cleanOlDescription(d)
  if (d && typeof d === 'object' && typeof (d as { value?: unknown }).value === 'string') {
    return cleanOlDescription((d as { value: string }).value)
  }
  return null
}

// ── candidate_cache (TTL) ──────────────────────────────────────────────────────

interface CacheRow {
  payload_json: string
  fetched_at: number
}

/** Fresh cached docs for a query key, or null on miss / stale / parse failure. */
function readCache(queryKey: string, ttlMs: number, now: number): OpenLibraryDoc[] | null {
  if (!isDbOpen()) return null // background prewarm racing a backup-import DB close → miss.
  const row = get<CacheRow>(
    `SELECT payload_json, fetched_at FROM candidate_cache WHERE query_key = ?`,
    [queryKey],
  )
  if (!row) return null
  if (now - row.fetched_at > ttlMs) return null // stale → force a re-fetch
  try {
    return JSON.parse(row.payload_json) as OpenLibraryDoc[]
  } catch {
    return null
  }
}

function writeCache(queryKey: string, docs: OpenLibraryDoc[], now: number): void {
  if (!isDbOpen()) return // DB closed under a background prewarm (import swap) — skip.
  run(
    `INSERT INTO candidate_cache (query_key, payload_json, fetched_at)
     VALUES (?, ?, ?)
     ON CONFLICT(query_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       fetched_at   = excluded.fetched_at`,
    [queryKey, JSON.stringify(docs), now],
  )
}

// ── fetch ───────────────────────────────────────────────────────────────────

function searchUrl(q: string, limit: number, page: number): string {
  const params = new URLSearchParams({
    q,
    fields: FIELDS,
    limit: String(limit),
    sort: SORT,
    language: LANGUAGE,
  })
  if (page > 1) params.set('page', String(page)) // OpenLibrary search.json native paging
  return `${OPENLIBRARY_SEARCH}?${params.toString()}`
}

/**
 * Docs for one seed query at a given 1-based page — cache-first, then network. A
 * single query failing (non-2xx or a thrown fetch) yields `[]` so one bad query
 * never sinks the batch. `page` is folded into the cache key so each page window
 * caches separately (Discover's "load more" pages deeper without re-fetching page 1).
 */
async function fetchDocsForQuery(
  q: string,
  cfg: CandidatesConfig,
  now: number,
  page: number,
): Promise<OpenLibraryDoc[]> {
  const queryKey = `${q}::l=${cfg.LIMIT_PER_QUERY}::p=${page}::s=${SORT}::lang=${LANGUAGE}`
  const cached = readCache(queryKey, cfg.CACHE_TTL_MS, now)
  if (cached) return cached
  try {
    const res = await fetch(searchUrl(q, cfg.LIMIT_PER_QUERY, page), {
      signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS),
      headers: OL_HEADERS,
    })
    if (!res.ok) return []
    const body = (await res.json()) as { docs?: OpenLibraryDoc[] }
    const docs = body.docs ?? []
    writeCache(queryKey, docs, now)
    return docs
  } catch {
    return []
  }
}

/**
 * A single work's description (the OpenLibrary N+1) — cache-first, per-work.
 * Synthetic keys (no real work) and any fetch failure / absent blurb resolve to
 * null, and that null is cached too so a blurb-less work isn't re-fetched every
 * refresh. The `oldesc:` cache is deliberately NOT version-namespaced — a work's
 * description is recipe-independent. Touches the network + candidate_cache.
 */
export async function fetchWorkDescription(
  workKey: string,
  cfg: CandidatesConfig,
  now: number,
): Promise<string | null> {
  if (!workKey.startsWith('/works/')) return null // synthetic:… → nothing to fetch
  const cacheKey = `oldesc:${workKey}`
  const cached = readCandidateCache<{ description: string | null }>(
    cacheKey,
    cfg.DESCRIPTION_CACHE_TTL_MS,
    now,
  )
  if (cached) return cached.description

  let description: string | null = null
  try {
    const res = await fetch(`${OPENLIBRARY_ORIGIN}${workKey}.json`, {
      signal: AbortSignal.timeout(cfg.FETCH_TIMEOUT_MS),
      headers: OL_HEADERS,
    })
    if (res.ok) description = extractOlDescription(await res.json())
  } catch {
    description = null // degrade to metadata-only for this book
  }
  writeCandidateCache(cacheKey, { description }, now)
  return description
}

/** Map `items` with at most `limit` calls in flight, preserving input order in the result. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Fetch, normalize, dedup and cap the candidate set for a batch of seed queries.
 * Queries fetch with bounded concurrency (`CONCURRENCY`) — OpenLibrary is a robust
 * single-host API, so a small in-flight pool is polite and much faster than serial.
 * Results are kept in query order, so dedup by `sourceId` (first occurrence wins —
 * queries are weight-ordered by the seeder) is unchanged. Touches the network +
 * candidate_cache; the caller (C4.4) filters and reranks the result.
 */
export async function fetchCandidates(
  queries: SeedQuery[],
  opts: { now?: number; cfg?: CandidatesConfig; page?: number } = {},
): Promise<Candidate[]> {
  const cfg = opts.cfg ?? CANDIDATES
  const now = opts.now ?? Date.now()
  const page = opts.page ?? 1
  // [discover-timing] OpenLibrary splits into a cheap search phase and the expensive
  // per-work description N+1 — time them separately so we can see which dominates.
  const tSearch = timingNow()
  const docsPerQuery = await mapPool(queries, cfg.CONCURRENCY, (q) =>
    fetchDocsForQuery(q.q, cfg, now, page),
  )
  logTiming('ol:search', tSearch, { queries: queries.length })
  const byId = new Map<string, Candidate>()
  for (const docs of docsPerQuery) {
    if (byId.size >= cfg.MAX_CANDIDATES) break
    for (const doc of docs) {
      const cand = normalizeOpenLibraryDoc(doc, cfg)
      if (!cand || byId.has(cand.sourceId)) continue
      byId.set(cand.sourceId, cand)
      if (byId.size >= cfg.MAX_CANDIDATES) break
    }
  }

  // Enrich each deduped book with its work description (the OpenLibrary N+1),
  // bounded-concurrency and cache-first per-work — so descriptions influence the
  // whole pool's ranking, and a warm refresh (all cached) fetches nothing.
  const tDesc = timingNow()
  const enriched = await mapPool(
    [...byId.values()],
    cfg.DESCRIPTION_CONCURRENCY,
    async (c): Promise<Candidate> => ({
      ...c,
      description: await fetchWorkDescription(c.sourceId, cfg, now),
    }),
  )
  logTiming('ol:descriptions', tDesc, {
    books: byId.size,
    concurrency: cfg.DESCRIPTION_CONCURRENCY,
  })
  // Drop books whose fetched blurb reads as non-English (the German-book leak the title gate
  // can't catch — English-looking title, fully German description). Only possible post-enrich,
  // so it lives here rather than in normalizeOpenLibraryDoc.
  return enriched.filter((c) => !looksNonEnglishDescription(c.description))
}
