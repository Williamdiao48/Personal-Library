import { useEffect, useRef } from 'react'
import { Routes, Route } from 'react-router-dom'
import { SettingsProvider } from './contexts/SettingsContext'
import { ToastProvider, useToast } from './contexts/ToastContext'
import { UpdaterProvider, useUpdater } from './contexts/UpdaterContext'
import LibraryView from './components/Library/LibraryView'
import ReaderView from './components/Reader/ReaderView'
import StatsView from './components/Stats/StatsView'
import SettingsView from './components/Settings/SettingsView'
import TrashView from './components/Library/TrashView'
import CollectionView from './components/Library/CollectionView'
import TagsView from './components/Library/TagsView'
import DiscoverView from './components/Discover/DiscoverView'
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

export default function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <UpdaterProvider>
          <ToastProvider>
            <UpdaterListener />
            <Routes>
              <Route path="/" element={<LibraryView />} />
              <Route path="/read/:id" element={<ReaderView />} />
              <Route path="/stats" element={<StatsView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="/trash" element={<TrashView />} />
              <Route path="/collection/:id" element={<CollectionView />} />
              <Route path="/tags" element={<TagsView />} />
              <Route path="/discover" element={<DiscoverView />} />
            </Routes>
          </ToastProvider>
        </UpdaterProvider>
      </SettingsProvider>
    </ErrorBoundary>
  )
}
