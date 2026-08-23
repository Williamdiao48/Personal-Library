import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { captureService } from '../services/capture'
import type { BatchJob, BulkSource, CaptureJob } from '../types'

// App-level capture-job tracking. Previously this lived inside LibraryView, so a
// job started from another route (Discover's "Add to Library") had no owner — no
// sidebar entry, and its progress/complete/error events were dropped whenever
// LibraryView wasn't mounted. Mounting this provider above the router registers the
// capture:* listeners for the app's whole lifetime, so no event is ever missed and
// any view can start a job (startJob) or read the shared list (captureJobs).
//
// Bulk favorites imports are tracked here too (batchJobs), as ONE aggregate row per
// batch — the batch runs captureUrl internally in main, so there is never a per-work
// CaptureJob; the row shows live done/skipped/failed counts + a Cancel button.

interface CaptureJobsCtx {
  captureJobs: CaptureJob[]
  /** Track a job the moment capture:start returns its jobId (renders in the sidebar). */
  startJob: (jobId: string, url: string) => void
  dismissJob: (jobId: string) => void
  batchJobs: BatchJob[]
  /** Track a bulk import the moment capture:startBulk returns its batchId. `titles`
   *  maps each work URL to its title (from the preview) so the row can name the
   *  book currently downloading. */
  startBatch: (
    batchId: string,
    source: BulkSource,
    label: string,
    total: number,
    titles?: Record<string, string>,
  ) => void
  /** Ask main to stop a running batch (it finishes the in-flight work, then reports cancelled). */
  cancelBatch: (batchId: string) => void
  dismissBatch: (batchId: string) => void
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
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([])

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

  const dismissBatch = useCallback((batchId: string) => {
    setBatchJobs((prev) => prev.filter((b) => b.id !== batchId))
  }, [])

  const startBatch = useCallback(
    (
      batchId: string,
      source: BulkSource,
      label: string,
      total: number,
      titles?: Record<string, string>,
    ) => {
      setBatchJobs((prev) => [
        ...prev,
        {
          id: batchId,
          source,
          label,
          total,
          done: 0,
          failed: 0,
          skipped: 0,
          retrying: 0,
          titles,
          status: 'running',
          startedAt: Date.now(),
        },
      ])
    },
    [],
  )

  const cancelBatch = useCallback((batchId: string) => {
    // Optimistic hint so the row shows we're stopping; main confirms with a
    // cancelled batchComplete once the in-flight work finishes.
    setBatchJobs((prev) => prev.map((b) => (b.id === batchId ? { ...b, current: undefined } : b)))
    void captureService.cancelBulk(batchId)
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

    // Bulk import: fold each progress/complete snapshot into the matching batch row.
    const applyBatch = (p: import('../types').BulkImportProgress): void => {
      setBatchJobs((prev) =>
        prev.map((b) =>
          b.id === p.batchId
            ? {
                ...b,
                total: p.total,
                done: p.done,
                failed: p.failed,
                skipped: p.skipped,
                retrying: p.retrying,
                current: p.current,
                status: p.status,
                error: p.error,
              }
            : b,
        ),
      )
    }
    const offBatchProgress = window.api.onBatchProgress(applyBatch)
    const offBatchComplete = window.api.onBatchComplete((p) => {
      applyBatch(p)
      // A clean finish / cancel auto-dismisses; throttled + error stay so the user
      // sees why and can act (re-run later).
      if (p.status === 'done' || p.status === 'cancelled') {
        setTimeout(() => dismissBatch(p.batchId), 6000)
      }
    })

    return () => {
      offProgress()
      offComplete()
      offError()
      offBatchProgress()
      offBatchComplete()
    }
  }, [dismissJob, dismissBatch])

  return (
    <CaptureJobsContext.Provider
      value={{
        captureJobs,
        startJob,
        dismissJob,
        batchJobs,
        startBatch,
        cancelBatch,
        dismissBatch,
      }}
    >
      {children}
    </CaptureJobsContext.Provider>
  )
}

export function useCaptureJobs() {
  const ctx = useContext(CaptureJobsContext)
  if (!ctx) throw new Error('useCaptureJobs must be used inside CaptureJobsProvider')
  return ctx
}
