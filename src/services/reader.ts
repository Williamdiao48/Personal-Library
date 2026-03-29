import type { EpubBook } from '../types'

export const readerService = {
  loadContent:       (relativePath: string): Promise<string>     => window.api.reader.loadContent(relativePath),
  loadBinaryContent: (relativePath: string): Promise<Uint8Array> => window.api.reader.loadBinaryContent(relativePath),
  loadEpub:          (relativePath: string): Promise<EpubBook>   => window.api.reader.loadEpub(relativePath),
  getChapterCount:   (relativePath: string): Promise<number>     => window.api.reader.getChapterCount(relativePath),
  loadChapter:       (relativePath: string, index: number): Promise<string> => window.api.reader.loadChapter(relativePath, index),
}
