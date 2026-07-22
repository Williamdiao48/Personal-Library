import { createContext, useContext, useEffect, useState } from 'react'
import type { HighlightColor } from '../types'
import { DEFAULT_HIGHLIGHT_LABELS } from '../constants/highlightColors'

export type Theme =
  | 'dark'
  | 'darker'
  | 'light'
  | 'sepia'
  | 'ivory'
  | 'slate'
  | 'lavender'
  | 'ocean'
  | 'nord'
  | 'rose'
  | 'forest'
  | 'high-contrast'
  | 'dusk'
  | 'midnight'
  | 'sand'
export type GridDensity = 'compact' | 'normal' | 'comfortable'
/** Discover content-type filter: everything, published books only, or fanfiction only. */
export type ContentMode = 'all' | 'books' | 'fanfiction'
export type SortBy =
  'date_saved' | 'last_read' | 'title' | 'word_count' | 'progress' | 'rating_high' | 'rating_low'

export interface CustomTheme {
  id: string
  name: string
  // seed colors the user picks
  bg: string
  accent: string
  isLight: boolean
  // derived on save
  bgSurface: string
  bgHover: string
  border: string
  text: string
  textMuted: string
  accentDim: string
  coverScrim: string
}

export interface AppSettings {
  theme: string // Theme id (built-in name or custom UUID)
  showAuthors: boolean
  showProgress: boolean
  gridDensity: GridDensity
  defaultSort: SortBy
  customThemes: CustomTheme[]
  enableDiscover: boolean // show the Discover recommendations panel
  discoverContentMode: ContentMode // Discover feed filter: all / books / fanfiction
  // Opt-in local-LLM (Ollama) reranking of BOOK recommendations. Off by default;
  // synced to the main process (like enableDiscover). model/baseUrl target the local
  // Ollama server. Falls back silently to cosine ordering when unreachable.
  llmRerankEnabled: boolean
  llmModel: string
  llmBaseUrl: string
  // User-facing meaning for each highlight color (e.g. yellow = "Key quote").
  // Drives the color-category legend/filters. App-global config, not per-annotation.
  highlightLabels: Record<HighlightColor, string>
  // When false, colors are purely visual: category chips/exports drop the meaning
  // and swatch tooltips show plain color names. Custom labels are preserved.
  highlightLabelsEnabled: boolean
}

const CUSTOM_THEME_VARS: Array<[keyof CustomTheme, string]> = [
  ['bg', '--bg'],
  ['bgSurface', '--bg-surface'],
  ['bgHover', '--bg-hover'],
  ['border', '--border'],
  ['text', '--text'],
  ['textMuted', '--text-muted'],
  ['accent', '--accent'],
  ['accentDim', '--accent-dim'],
  ['coverScrim', '--cover-scrim'],
]

const DEFAULTS: AppSettings = {
  theme: 'dark',
  showAuthors: true,
  showProgress: true,
  gridDensity: 'normal',
  defaultSort: 'date_saved',
  customThemes: [],
  enableDiscover: true,
  discoverContentMode: 'all',
  llmRerankEnabled: false,
  llmModel: 'llama3.2:3b',
  llmBaseUrl: 'http://127.0.0.1:11434',
  highlightLabels: DEFAULT_HIGHLIGHT_LABELS,
  highlightLabelsEnabled: true,
}

const STORAGE_KEY = 'app-settings'

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return DEFAULTS
  }
}

const LIGHT_THEMES = new Set<string>(['light', 'sepia', 'ivory', 'slate', 'lavender'])

function applyToDOM(settings: AppSettings) {
  const html = document.documentElement
  html.dataset.density = settings.gridDensity

  if (settings.showAuthors) delete html.dataset.hideAuthors
  else html.dataset.hideAuthors = ''

  if (settings.showProgress) delete html.dataset.hideProgress
  else html.dataset.hideProgress = ''

  const customTheme = settings.customThemes.find((t) => t.id === settings.theme)
  if (customTheme) {
    html.dataset.theme = 'custom'
    html.dataset.themeMode = customTheme.isLight ? 'light' : 'dark'
    for (const [key, cssVar] of CUSTOM_THEME_VARS) {
      html.style.setProperty(cssVar, customTheme[key] as string)
    }
  } else {
    for (const [, cssVar] of CUSTOM_THEME_VARS) {
      html.style.removeProperty(cssVar)
    }
    html.dataset.theme = settings.theme
    html.dataset.themeMode = LIGHT_THEMES.has(settings.theme) ? 'light' : 'dark'
  }
}

interface SettingsContextValue {
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const loaded = loadSettings()
    applyToDOM(loaded)
    return loaded
  })

  useEffect(() => {
    applyToDOM(settings)
  }, [settings])

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}

/**
 * Like {@link useSettings} but returns DEFAULTS when no provider is mounted,
 * rather than throwing. For leaf components (e.g. the in-reader selection popup)
 * that always sit under the app's SettingsProvider in production but get
 * unit-tested in isolation without one.
 */
export function useSettingsSafe(): AppSettings {
  return useContext(SettingsContext)?.settings ?? DEFAULTS
}
