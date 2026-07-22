import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { SettingsProvider, useSettings, useSettingsSafe, type CustomTheme } from './SettingsContext'

const html = () => document.documentElement

function setup() {
  return renderHook(() => useSettings(), { wrapper: SettingsProvider })
}

const customTheme: CustomTheme = {
  id: 'c1',
  name: 'Mine',
  bg: '#111111',
  accent: '#ff0000',
  isLight: false,
  bgSurface: '#222222',
  bgHover: '#333333',
  border: '#444444',
  text: '#eeeeee',
  textMuted: '#aaaaaa',
  accentDim: '#880000',
  coverScrim: '#000000',
}

beforeEach(() => {
  localStorage.clear()
  const h = html()
  delete h.dataset.theme
  delete h.dataset.themeMode
  delete h.dataset.density
  delete h.dataset.hideAuthors
  delete h.dataset.hideProgress
  h.removeAttribute('style')
})

describe('SettingsContext', () => {
  it('falls back to defaults and applies them to <html> when storage is empty', () => {
    const { result } = setup()
    expect(result.current.settings.theme).toBe('dark')
    expect(html().dataset.theme).toBe('dark')
    expect(html().dataset.themeMode).toBe('dark')
    expect(html().dataset.density).toBe('normal')
  })

  it('recovers to defaults when the stored JSON is malformed', () => {
    localStorage.setItem('app-settings', '{not valid json')
    const { result } = setup()
    expect(result.current.settings.theme).toBe('dark')
  })

  it('persists updates and applies light-mode for a light theme', () => {
    const { result } = setup()
    act(() => result.current.updateSettings({ theme: 'light' }))
    expect(html().dataset.themeMode).toBe('light')
    expect(JSON.parse(localStorage.getItem('app-settings')!).theme).toBe('light')
  })

  it('toggles the hide-authors / hide-progress data attributes both ways', () => {
    const { result } = setup()
    act(() => result.current.updateSettings({ showAuthors: false, showProgress: false }))
    expect(html().dataset.hideAuthors).toBe('')
    expect(html().dataset.hideProgress).toBe('')
    act(() => result.current.updateSettings({ showAuthors: true, showProgress: true }))
    expect(html().dataset.hideAuthors).toBeUndefined()
    expect(html().dataset.hideProgress).toBeUndefined()
  })

  it('applies a selected custom theme as CSS variables on <html>', () => {
    const { result } = setup()
    act(() => result.current.updateSettings({ customThemes: [customTheme], theme: 'c1' }))
    expect(html().dataset.theme).toBe('custom')
    expect(html().dataset.themeMode).toBe('dark')
    expect(html().style.getPropertyValue('--bg')).toBe('#111111')
    expect(html().style.getPropertyValue('--accent')).toBe('#ff0000')
  })

  it('removes custom CSS variables when switching back to a built-in theme', () => {
    const { result } = setup()
    act(() => result.current.updateSettings({ customThemes: [customTheme], theme: 'c1' }))
    act(() => result.current.updateSettings({ theme: 'dark' }))
    expect(html().dataset.theme).toBe('dark')
    expect(html().style.getPropertyValue('--bg')).toBe('')
  })

  it('useSettings throws when used outside a provider', () => {
    expect(() => renderHook(() => useSettings())).toThrow(/SettingsProvider/)
  })

  it('defaults highlightLabelsEnabled to true and persists a disable toggle', () => {
    const { result } = setup()
    expect(result.current.settings.highlightLabelsEnabled).toBe(true)
    act(() => result.current.updateSettings({ highlightLabelsEnabled: false }))
    expect(result.current.settings.highlightLabelsEnabled).toBe(false)
    expect(JSON.parse(localStorage.getItem('app-settings')!).highlightLabelsEnabled).toBe(false)
  })

  it('useSettingsSafe returns defaults outside a provider instead of throwing', () => {
    const { result } = renderHook(() => useSettingsSafe())
    expect(result.current.highlightLabelsEnabled).toBe(true)
    expect(result.current.theme).toBe('dark')
  })
})
