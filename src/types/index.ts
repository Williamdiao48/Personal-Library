export type ContentType   = 'article' | 'epub' | 'pdf'
export type ReadingStatus = 'unread' | 'reading' | 'finished' | 'on-hold' | 'dropped'

/** Returns the effective reading status, preferring the explicit DB value over
 *  the scroll_position inference. Use this everywhere status is displayed or filtered. */
export function getEffectiveStatus(item: Item): ReadingStatus {
  if (item.status != null) return item.status
  if (!item.scroll_position || item.scroll_position === 0) return 'unread'
  if (item.scroll_position >= 1) return 'finished'
  return 'reading'
}

export interface Item {
  id: string
  title: string
  author: string | null
  source_url: string | null
  content_type: ContentType
  file_path: string
  word_count: number | null
  cover_path: string | null
  description: string | null
  date_saved: number
  date_modified: number
  derived_from?: string | null   // UUID of source PDF if this is a converted EPUB
  chapter_start?: number | null
  chapter_end?:   number | null
  // joined from progress
  scroll_position?: number
  last_read_at?: number
  scroll_chapter?: number | null
  scroll_y?: number | null
  status?: ReadingStatus | null  // null / undefined = infer from scroll_position
}

export interface Tag {
  id: string
  name: string
  color: string
}

export interface Collection {
  id: string
  name: string
  date_created: number
}

// ── Reading stats types ──────────────────────────────────────────

export interface StatsSummary {
  totalMs:       number   // sum of all session durations
  itemsStarted:  number   // distinct items with at least one session
  itemsFinished: number   // items with scroll_position >= 1
  wordsRead:     number   // estimated words read across all items
}

export interface DailyReading {
  date:    string  // 'YYYY-MM-DD' (local time)
  totalMs: number  // total ms of reading that day
}

export interface ItemStats {
  id:              string
  title:           string
  author:          string | null
  content_type:    ContentType
  word_count:      number | null
  scroll_position: number         // 0.0–1.0
  total_ms:        number         // total session time for this item
  session_count:   number
  last_read_at:    number | null  // unix ms
  avg_wpm:         number | null  // estimated words/minute; null if insufficient data
}

export interface StreakInfo {
  currentStreak: number   // consecutive days with ≥1 session ending today or yesterday
  longestStreak: number   // all-time longest run of consecutive reading days
}

export type GoalType   = 'time' | 'count' | 'list'
export type GoalPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface GoalItem {
  item_id:        string
  title:          string
  author:         string | null
  finished:       boolean   // scroll_position >= 1 OR status = 'finished'
  scroll_position: number   // 0.0–1.0
}

export interface Goal {
  id:             string
  type:           GoalType
  title:          string
  period:         GoalPeriod | null   // null for list goals
  target_minutes: number | null       // type='time'
  target_count:   number | null       // type='count'
  created_at:     number
  // Computed on fetch:
  current_value:  number              // minutes read (time) or finished items (count/list)
  total_items:    number              // list goals: total items in list; others: 0
  items:          GoalItem[]          // list goals only; empty array otherwise
}

export interface CaptureResult {
  id: string
  title: string
  author: string | null
  wordCount: number | null
}

// A background URL capture job tracked in the renderer while the main process
// fetches and parses the content asynchronously.
export interface CaptureJob {
  id:        string            // uuid returned by capture:start
  url:       string            // source URL being captured
  status:    'running' | 'done' | 'error'
  msg:       string            // latest progress message
  chapter:   number | null     // parsed from "Fetching chapter N of M…"
  total:     number | null     // parsed from chapter or total-count messages
  startedAt: number            // Date.now() when the job was started
  title?:    string            // set on completion
  error?:    string            // set on failure
}

export interface RefreshResult {
  /** True when the re-scraped word count differs from the stored value. */
  changed:   boolean
  wordCount: number
}

export interface EpubChapter { title: string; html: string }
export interface EpubBook    { chapters: EpubChapter[] }

export interface ConvertChapter { title: string; content: string }
export interface ConvertPayload { itemId: string; chapters: ConvertChapter[] }
export interface ConvertResult  { id: string; title: string }

// ── Annotation types ─────────────────────────────────────────────

export type AnnotationType = 'bookmark' | 'highlight' | 'note'

export interface Annotation {
  id:             string
  item_id:        string
  type:           AnnotationType
  chapter_index:  number | null   // 0-based chapter; null = whole-document / PDF
  position:       number          // 0.0-1.0 scroll fraction OR PDF page number
  selected_text:  string | null
  context_before: string | null
  context_after:  string | null
  note_text:      string | null
  created_at:     number          // unix ms
}

export interface CreateAnnotationPayload {
  item_id:        string
  type:           AnnotationType
  chapter_index:  number | null
  position:       number
  selected_text?: string | null
  context_before?: string | null
  context_after?:  string | null
  note_text?:     string | null
}

export interface BackupExportResult {
  path:          string
  itemCount:     number
  fileSizeBytes: number
}

// Type the window.api surface so the renderer gets full type-safety
export interface Api {
  library: {
    getAll:         ()                              => Promise<Item[]>
    getById:        (id: string)                   => Promise<Item | undefined>
    delete:         (id: string)                                 => Promise<void>
    updateProgress: (id: string, pos: number)                    => Promise<void>
    saveScrollPos:  (id: string, chapter: number, scrollY: number) => Promise<void>
    search:         (query: string)                              => Promise<Item[]>
    getAllItemTags:  ()                                           => Promise<{ item_id: string; tag_id: string; name: string; color: string }[]>
    setCover:       (id: string, data: ArrayBuffer, ext: string) => Promise<string>
    pickCover:      (id: string)                                 => Promise<string | null>
    setAuthor:      (id: string, author: string | null)          => Promise<void>
    setStatus:      (id: string, status: ReadingStatus | null)  => Promise<void>
    refresh:        (id: string)                                 => Promise<RefreshResult>
  }
  tags: {
    getAll:     ()                                  => Promise<Tag[]>
    getForItem: (itemId: string)                   => Promise<Tag[]>
    setForItem: (itemId: string, tagIds: string[]) => Promise<void>
    create:     (name: string, color: string)      => Promise<Tag>
    delete:     (id: string)                       => Promise<void>
  }
  capture: {
    start:    (url: string, start?: number, end?: number) => Promise<string>  // returns jobId immediately
    fromFile: ()                                           => Promise<CaptureResult | null>
    append:   (itemId: string, end: number)               => Promise<string>
  }
  reader: {
    loadContent:       (relativePath: string)                    => Promise<string>
    loadBinaryContent: (relativePath: string)                    => Promise<Uint8Array>
    loadEpub:          (relativePath: string)                    => Promise<EpubBook>
    getChapterCount:   (relativePath: string)                    => Promise<number>
    loadChapter:       (relativePath: string, index: number)     => Promise<string>
  }
  collections: {
    getAll:                ()                                    => Promise<Collection[]>
    create:                (name: string)                        => Promise<Collection>
    delete:                (id: string)                          => Promise<void>
    rename:                (id: string, name: string)            => Promise<void>
    getAllItemCollections: ()                                     => Promise<{ item_id: string; collection_id: string; name: string }[]>
    setForItem:            (itemId: string, ids: string[])       => Promise<void>
  }
  convert: {
    pdfToEpub: (payload: ConvertPayload) => Promise<ConvertResult>
  }
  backup: {
    export: () => Promise<BackupExportResult | null>  // null = user cancelled
    import: () => Promise<void>                        // never resolves (app relaunches)
  }
  stats: {
    recordSession: (itemId: string, startedAt: number, endedAt: number) => Promise<void>
    getSummary:    ()             => Promise<StatsSummary>
    getTimeline:   (days: number) => Promise<DailyReading[]>
    getByItem:     ()             => Promise<ItemStats[]>
    getStreaks:    ()             => Promise<StreakInfo>
  }
  goals: {
    getAll:     ()                                                                                  => Promise<Goal[]>
    create:     (payload: { type: GoalType; title: string; period?: GoalPeriod; targetMinutes?: number; targetCount?: number }) => Promise<Goal>
    update:     (id: string, patch: { title?: string; period?: GoalPeriod | null; targetMinutes?: number | null; targetCount?: number | null }) => Promise<void>
    delete:     (id: string)                          => Promise<void>
    addItem:    (goalId: string, itemId: string)      => Promise<void>
    removeItem:       (goalId: string, itemId: string)                               => Promise<void>
    upsertPeriodGoal: (type: 'time' | 'count', period: GoalPeriod, target: number | null) => Promise<Goal | null>
  }
  annotations: {
    getForItem: (itemId: string)                              => Promise<Annotation[]>
    create:     (payload: CreateAnnotationPayload)            => Promise<Annotation>
    updateNote: (id: string, noteText: string | null)         => Promise<void>
    delete:     (id: string)                                  => Promise<void>
  }
  onRequestCapture:  (callback: (url: string) => void) => () => void
  onCaptureProgress: (callback: (payload: { jobId: string; msg: string }) => void) => () => void
  onCaptureComplete: (callback: (payload: { jobId: string; result: CaptureResult }) => void) => () => void
  onCaptureError:    (callback: (payload: { jobId: string; error: string }) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
