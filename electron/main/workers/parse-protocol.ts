// Message contract shared between the main-process host (parse-host.ts) and the
// sandboxed child (parse-worker.ts). Types only — no imports, no runtime code —
// so it is safe to pull into the Electron-free worker bundle.

export interface EpubParseResult {
  title:       string | null
  author:      string | null
  coverBuffer: Buffer | null
  coverExt:    string | null
  plainText:   string
  wordCount:   number | null
}

export type ParseRequest =
  | { id: number; kind: 'epub'; filePath: string }

export type ParseResponse =
  | { id: number; ok: true;  result: EpubParseResult }
  | { id: number; ok: false; error: string }
