import { Routes, Route } from 'react-router-dom'
import { SettingsProvider } from './contexts/SettingsContext'
import { ToastProvider } from './contexts/ToastContext'
import LibraryView from './components/Library/LibraryView'
import ReaderView from './components/Reader/ReaderView'
import StatsView from './components/Stats/StatsView'
import SettingsView from './components/Settings/SettingsView'
import ErrorBoundary from './components/ErrorBoundary'

export default function App() {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <ToastProvider>
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
