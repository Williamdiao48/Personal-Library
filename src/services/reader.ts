import type { EpubBook } from '../types'

export const readerService = {
  loadContent: (relativePath: string): Promise<string> =>
    window.api.reader.loadContent(relativePath),
  loadBinaryContent: (relativePath: string): Promise<Uint8Array> =>
    window.api.reader.loadBinaryContent(relativePath),
  loadEpub: (relativePath: string): Promise<EpubBook> => window.api.reader.loadEpub(relativePath),
  getChapterCount: (relativePath: string): Promise<number> =>
    window.api.reader.getChapterCount(relativePath),
  loadChapter: (relativePath: string, index: number): Promise<string> =>
    window.api.reader.loadChapter(relativePath, index),
  /** Replay a web-view blur→focus transition — the only thing that syncs the macOS
   *  text-input state for a programmatically focused input in the PDF reader, so the
   *  search field is typeable without a manual click (see reader.ts IPC handler). */
  resyncFocus: (): Promise<void> => window.api.reader.resyncFocus(),
}
