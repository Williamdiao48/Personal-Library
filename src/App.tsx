import { useEffect, useRef } from 'react'
import { Routes, Route } from 'react-router-dom'
import { SettingsProvider } from './contexts/SettingsContext'
import { ToastProvider, useToast } from './contexts/ToastContext'
import LibraryView from './components/Library/LibraryView'
import ReaderView from './components/Reader/ReaderView'
import StatsView from './components/Stats/StatsView'
import SettingsView from './components/Settings/SettingsView'
import ErrorBoundary from './components/ErrorBoundary'

/** Subscribes to auto-updater events and surfaces them as Toast notifications.
 *  Must live inside ToastProvider so it can call useToast(). */
function UpdaterListener() {
  const { addToast, updateToast, removeToast } = useToast()
  const downloadToastId = useRef<string | null>(null)

  useEffect(() => {
    if (!window.api?.updater) return

    const unsubAvailable = window.api.updater.onUpdateAvailable(({ version }) => {
      downloadToastId.current = addToast(
        `v${version} available — click to download`,
        'info',
        undefined,
        () => window.api.updater.downloadUpdate()
      )
    })

    const unsubProgress = window.api.updater.onDownloadProgress(({ percent }) => {
      if (downloadToastId.current) {
        updateToast(downloadToastId.current, `Downloading update… ${percent}%`, 'info')
      }
    })

    const unsubDownloaded = window.api.updater.onUpdateDownloaded(() => {
      if (downloadToastId.current) removeToast(downloadToastId.current)
      downloadToastId.current = null
      addToast(
        'Update ready — click to restart',
        'success',
        undefined,
        () => window.api.updater.quitAndInstall()
      )
    })

    const unsubError = window.api.updater.onError(({ message }) => {
      if (downloadToastId.current) removeToast(downloadToastId.current)
      downloadToastId.current = null
      // Suppress generic network errors — they're noisy and expected offline
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
        <ToastProvider>
          <UpdaterListener />
          <Routes>
            <Route path="/" element={<LibraryView />} />
            <Route path="/read/:id" element={<ReaderView />} />
            <Route path="/stats" element={<StatsView />} />
            <Route path="/settings" element={<SettingsView />} />
          </Routes>
        </ToastProvider>
      </SettingsProvider>
    </ErrorBoundary>
  )
}
