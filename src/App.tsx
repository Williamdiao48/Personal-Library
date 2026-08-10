import { useEffect, useRef } from 'react'
import { Routes, Route } from 'react-router-dom'
import { SettingsProvider, useSettings } from './contexts/SettingsContext'
import { discoverService } from './services/discover'
import { llmService } from './services/llm'
import { syncService } from './services/sync'
import { processingService } from './services/processing'
import { ToastProvider, useToast } from './contexts/ToastContext'
import { UpdaterProvider, useUpdater } from './contexts/UpdaterContext'
import { CaptureJobsProvider } from './contexts/CaptureJobsContext'
import { AuthProvider } from './contexts/AuthContext'
import LibraryView from './components/Library/LibraryView'
import ReaderView from './components/Reader/ReaderView'
import StatsView from './components/Stats/StatsView'
import SettingsView from './components/Settings/SettingsView'
import TrashView from './components/Library/TrashView'
import CollectionView from './components/Library/CollectionView'
import TagsView from './components/Library/TagsView'
import AuthorsView from './components/Library/AuthorsView'
import DiscoverView from './components/Discover/DiscoverView'
import AnnotationsView from './components/Annotations/AnnotationsView'
import SyncStatusPill from './components/SyncStatusPill'
import ErrorBoundary from './components/ErrorBoundary'

/** Subscribes to auto-updater events and surfaces them as Toast notifications.
 *  Must live inside ToastProvider and UpdaterProvider. */
function UpdaterListener() {
  const { addToast, updateToast, removeToast } = useToast()
  const { setPendingVersion } = useUpdater()
  const downloadToastId = useRef<string | null>(null)

  useEffect(() => {
    if (!window.api?.updater) return

    const unsubAvailable = window.api.updater.onUpdateAvailable(({ version }) => {
      setPendingVersion(version)
      downloadToastId.current = addToast(
        `v${version} available — click to download`,
        'info',
        undefined,
        () => window.api.updater.downloadUpdate(),
      )
    })

    const unsubProgress = window.api.updater.onDownloadProgress(({ percent }) => {
      if (!downloadToastId.current) {
        downloadToastId.current = addToast(`Downloading update… ${percent}%`, 'info')
      } else {
        updateToast(downloadToastId.current, `Downloading update… ${percent}%`, 'info')
      }
    })

    const unsubDownloaded = window.api.updater.onUpdateDownloaded(() => {
      if (downloadToastId.current) removeToast(downloadToastId.current)
      downloadToastId.current = null
      setPendingVersion(null)
      addToast('Update ready — click to restart', 'success', undefined, () =>
        window.api.updater.quitAndInstall(),
      )
    })

    const unsubError = window.api.updater.onError(({ message }) => {
      if (downloadToastId.current) removeToast(downloadToastId.current)
      downloadToastId.current = null
      if (!message.includes('net::ERR_')) {
        addToast('Update check failed', 'error')
      }
    })

    return () => {
      unsubAvailable()
      unsubProgress()
      unsubDownloaded()
      unsubError()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return null
}

/** Syncs the renderer-owned `enableDiscover` setting to the main process, which
 *  gates the background embedding backfill on it (embeddings serve only Discover).
 *  Must live inside SettingsProvider. */
function DiscoverBackfillSync() {
  const { settings } = useSettings()
  useEffect(() => {
    if (!window.api?.discover) return
    void discoverService.setEnabled(settings.enableDiscover)
  }, [settings.enableDiscover])

  // Sync the local-LLM book-reranker config to main (source of truth is localStorage,
  // re-synced on boot + on change), same pattern as enableDiscover above.
  useEffect(() => {
    if (!window.api?.llm) return
    void llmService.setConfig({
      enabled: settings.llmRerankEnabled,
      model: settings.llmModel,
      baseUrl: settings.llmBaseUrl,
    })
  }, [settings.llmRerankEnabled, settings.llmModel, settings.llmBaseUrl])

  // Mirror the library-sync master switch to main (source of truth is localStorage,
  // re-synced on boot + on change). Main gates every sync round on it + arms the
  // poll; actual sync additionally requires being signed in.
  useEffect(() => {
    if (!window.api?.sync) return
    void syncService.setEnabled(settings.enableSync)
  }, [settings.enableSync])

  // Mirror the cloud-processing master switch to main (source of truth is
  // localStorage, re-synced on boot + on change). Main reads it at each EPUB
  // import to decide off-device vs. local parsing; actual cloud use additionally
  // requires being signed in.
  useEffect(() => {
    if (!window.api?.processing) return
    void processingService.setEnabled(settings.enableCloudProcessing)
  }, [settings.enableCloudProcessing])
  return null
}

export default function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <DiscoverBackfillSync />
        <UpdaterProvider>
          <ToastProvider>
            <UpdaterListener />
            <AuthProvider>
              <CaptureJobsProvider>
                <Routes>
                  <Route path="/" element={<LibraryView />} />
                  <Route path="/read/:id" element={<ReaderView />} />
                  <Route path="/stats" element={<StatsView />} />
                  <Route path="/settings" element={<SettingsView />} />
                  <Route path="/trash" element={<TrashView />} />
                  <Route path="/collection/:id" element={<CollectionView />} />
                  <Route path="/tags" element={<TagsView />} />
                  <Route path="/authors" element={<AuthorsView />} />
                  <Route path="/discover" element={<DiscoverView />} />
                  <Route path="/annotations" element={<AnnotationsView />} />
                </Routes>
                <SyncStatusPill />
              </CaptureJobsProvider>
            </AuthProvider>
          </ToastProvider>
        </UpdaterProvider>
      </SettingsProvider>
    </ErrorBoundary>
  )
}
