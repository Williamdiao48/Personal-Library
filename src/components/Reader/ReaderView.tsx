import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { readerService } from '../../services/reader'
import type { Item } from '../../types'
import HtmlReader from './HtmlReader'
import EpubReader from './EpubReader'
import PdfReader from './PdfReader'
import { libraryService } from '../../services/library'

// True when file_path uses the per-chapter file format introduced in the lazy-loading refactor.
function isMultiChapterPath(filePath: string): boolean {
  return /-ch0\.html$/.test(filePath)
}

export default function ReaderView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [item, setItem] = useState<Item | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [chapterCount, setChapterCount] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasDerivedEpub, setHasDerivedEpub] = useState(false)
  const [contentStale, setContentStale] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    libraryService.getById(id).then(async (found) => {
      if (cancelled) return
      if (!found) { navigate('/'); return }
      setItem(found)
      // Record that the book was opened, updating last_read_at regardless of
      // whether the user navigates to a new page or chapter.
      libraryService.updateProgress(found.id, found.scroll_position ?? 0)
      // Background refresh check for articles with a source URL.
      // Runs the HEAD check (and full re-scrape if stale) silently; if content
      // changed, surfaces an "Updated" badge offering a one-click reload.
      if (found.content_type === 'article' && found.source_url) {
        libraryService.refresh(found.id).then(result => {
          if (!cancelled && result.changed) setContentStale(true)
        }).catch(() => { /* silent — don't disturb reading on network error */ })
      }
      if (found.content_type === 'pdf' || found.content_type === 'epub') {
        setContent('') // PdfReader / EpubReader load their own data internally
        if (found.content_type === 'pdf') {
          libraryService.getAll().then(all => {
            if (!cancelled) setHasDerivedEpub(all.some(i => i.derived_from === found.id))
          })
        }
        return
      }
      try {
        if (isMultiChapterPath(found.file_path)) {
          // Multi-chapter lazy-loading: load chapter count + first chapter only.
          // HtmlReader will request additional chapters via readerService.loadChapter.
          const [count, firstChHtml] = await Promise.all([
            readerService.getChapterCount(found.file_path),
            readerService.loadChapter(found.file_path, 0),
          ])
          if (!cancelled) {
            setChapterCount(count)
            setContent(firstChHtml)
          }
        } else {
          // Legacy single-file path (single articles + old multi-chapter items).
          const html = await readerService.loadContent(found.file_path)
          if (!cancelled) setContent(html)
        }
      } catch {
        if (!cancelled) setLoadError('Could not load content. The file may be missing or corrupted.')
      }
    })

    return () => { cancelled = true }
  }, [id])

  if (loadError) return (
    <div className="reader-loading reader-load-error">
      <p>{loadError}</p>
      <button onClick={() => navigate('/')}>Back to library</button>
    </div>
  )

  if (!item || content === null) return <div className="reader-loading">Loading…</div>

  return (
    <div className="reader-shell">
      {item.content_type === 'article' && (
        <HtmlReader
          item={item}
          content={content}
          onBack={() => navigate('/')}
          lazyChapterCount={chapterCount ?? undefined}
          contentStale={contentStale}
          onReloadContent={async () => {
            setContentStale(false)
            const fresh = await libraryService.getById(id!)
            if (!fresh) return
            setItem(fresh)
            if (isMultiChapterPath(fresh.file_path)) {
              const [count, firstChHtml] = await Promise.all([
                readerService.getChapterCount(fresh.file_path),
                readerService.loadChapter(fresh.file_path, 0),
              ])
              setChapterCount(count)
              setContent(firstChHtml)
            } else {
              const html = await readerService.loadContent(fresh.file_path)
              setContent(html)
            }
          }}
        />
      )}
      {item.content_type === 'epub' && (
        <EpubReader item={item} onBack={() => navigate('/')} />
      )}
      {item.content_type === 'pdf' && (
        <PdfReader item={item} onBack={() => navigate('/')} hasEpub={hasDerivedEpub} />
      )}
    </div>
  )
}
