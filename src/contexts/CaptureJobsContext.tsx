import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { CaptureJob } from '../types'

// App-level capture-job tracking. Previously this lived inside LibraryView, so a
// job started from another route (Discover's "Add to Library") had no owner — no
// sidebar entry, and its progress/complete/error events were dropped whenever
// LibraryView wasn't mounted. Mounting this provider above the router registers the
// capture:* listeners for the app's whole lifetime, so no event is ever missed and
// any view can start a job (startJob) or read the shared list (captureJobs).

interface CaptureJobsCtx {
  captureJobs: CaptureJob[]
  /** Track a job the moment capture:start returns its jobId (renders in the sidebar). */
  startJob: (jobId: string, url: string) => void
  dismissJob: (jobId: string) => void
}

const CaptureJobsContext = createContext<CaptureJobsCtx | null>(null)

/** Parse "Fetching chapter N of M…" or "Found M chapters…" from a progress msg. */
function parseChapterProgress(msg: string): { chapter?: number; total?: number } {
  const chMatch = /chapter (\d+) of (\d+)/i.exec(msg)
  if (chMatch) return { chapter: parseInt(chMatch[1]), total: parseInt(chMatch[2]) }
  const totalMatch = /\b(\d+) chapters?\b/i.exec(msg)
  if (totalMatch) return { total: parseInt(totalMatch[1]) }
  return {}
}

export function CaptureJobsProvider({ children }: { children: React.ReactNode }) {
  const [captureJobs, setCaptureJobs] = useState<CaptureJob[]>([])

  const startJob = useCallback((jobId: string, url: string) => {
    setCaptureJobs((prev) => [
      ...prev,
      {
        id: jobId,
        url,
        status: 'running',
        msg: 'Starting…',
        chapter: null,
        total: null,
        startedAt: Date.now(),
      },
    ])
  }, [])

  const dismissJob = useCallback((jobId: string) => {
    setCaptureJobs((prev) => prev.filter((j) => j.id !== jobId))
  }, [])

  useEffect(() => {
    const offProgress = window.api.onCaptureProgress(({ jobId, msg }) => {
      setCaptureJobs((prev) =>
        prev.map((j) => {
          if (j.id !== jobId) return j
          const { chapter, total } = parseChapterProgress(msg)
          return { ...j, msg, chapter: chapter ?? j.chapter, total: total ?? j.total }
        }),
      )
    })

    const offComplete = window.api.onCaptureComplete(({ jobId, result }) => {
      setCaptureJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: 'done', title: result.title } : j)),
      )
      setTimeout(() => dismissJob(jobId), 4000)
    })

    const offError = window.api.onCaptureError(({ jobId, error }) => {
      setCaptureJobs((prev) =>
        prev.map((j) => (j.id === jobId ? { ...j, status: 'error', error } : j)),
      )
    })

    return () => {
      offProgress()
      offComplete()
      offError()
    }
  }, [dismissJob])

  return (
    <CaptureJobsContext.Provider value={{ captureJobs, startJob, dismissJob }}>
      {children}
    </CaptureJobsContext.Provider>
  )
}

export function useCaptureJobs() {
  const ctx = useContext(CaptureJobsContext)
  if (!ctx) throw new Error('useCaptureJobs must be used inside CaptureJobsProvider')
  return ctx
}
