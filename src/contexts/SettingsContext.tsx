import { createContext, useContext, useEffect, useState } from 'react'

export type Theme       = 'dark' | 'darker' | 'light' | 'sepia' | 'ivory' | 'slate' | 'lavender' | 'ocean' | 'nord' | 'rose' | 'forest' | 'high-contrast'
export type GridDensity = 'compact' | 'normal' | 'comfortable'
export type SortBy      = 'date_saved' | 'last_read' | 'title' | 'word_count' | 'progress'

export interface CustomTheme {
  id:        string
  name:      string
  // seed colors the user picks
  bg:        string
  accent:    string
  isLight:   boolean
  // derived on save
  bgSurface: string
  bgHover:   string
  border:    string
  text:      string
  textMuted: string
  accentDim: string
  coverScrim: string
}

export interface AppSettings {
  theme:        string   // Theme id (built-in name or custom UUID)
  showAuthors:  boolean
  showProgress: boolean
  gridDensity:  GridDensity
  defaultSort:  SortBy
  customThemes: CustomTheme[]
}

const CUSTOM_THEME_VARS: Array<[keyof CustomTheme, string]> = [
  ['bg',        '--bg'],
  ['bgSurface', '--bg-surface'],
  ['bgHover',   '--bg-hover'],
  ['border',    '--border'],
  ['text',      '--text'],
  ['textMuted', '--text-muted'],
  ['accent',    '--accent'],
  ['accentDim', '--accent-dim'],
  ['coverScrim','--cover-scrim'],
]

const DEFAULTS: AppSettings = {
  theme:        'dark',
  showAuthors:  true,
  showProgress: true,
  gridDensity:  'normal',
  defaultSort:  'date_saved',
  customThemes: [],
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

function applyToDOM(settings: AppSettings) {
  const html = document.documentElement
  html.dataset.density = settings.gridDensity

  if (settings.showAuthors)  delete html.dataset.hideAuthors
  else                       html.dataset.hideAuthors = ''

  if (settings.showProgress) delete html.dataset.hideProgress
  else                       html.dataset.hideProgress = ''

  const customTheme = settings.customThemes.find(t => t.id === settings.theme)
  if (customTheme) {
    html.dataset.theme = 'custom'
    for (const [key, cssVar] of CUSTOM_THEME_VARS) {
      html.style.setProperty(cssVar, customTheme[key] as string)
    }
  } else {
    for (const [, cssVar] of CUSTOM_THEME_VARS) {
      html.style.removeProperty(cssVar)
    }
    html.dataset.theme = settings.theme
  }
}

interface SettingsContextValue {
  settings:       AppSettings
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
    setSettings(prev => {
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
