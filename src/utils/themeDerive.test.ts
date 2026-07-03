import { describe, it, expect } from 'vitest'
import { deriveCustomTheme, isValidHex } from './themeDerive'

describe('isValidHex', () => {
  it('accepts 6-digit hex with #', () => {
    expect(isValidHex('#ffffff')).toBe(true)
    expect(isValidHex('#0A1b2C')).toBe(true)
  })

  it('rejects shorthand, missing #, and non-hex chars', () => {
    expect(isValidHex('#fff')).toBe(false)
    expect(isValidHex('ffffff')).toBe(false)
    expect(isValidHex('#gggggg')).toBe(false)
    expect(isValidHex('#12345')).toBe(false)
  })
})

describe('deriveCustomTheme', () => {
  it('passes through seed values and produces all derived vars', () => {
    const t = deriveCustomTheme('id1', 'My Theme', '#101418', '#3b82f6', false)
    expect(t).toMatchObject({ id: 'id1', name: 'My Theme', bg: '#101418', accent: '#3b82f6', isLight: false })
    // Every derived field present and a valid hex (except coverScrim which is rgba).
    for (const key of ['bgSurface', 'bgHover', 'border', 'text', 'textMuted', 'accentDim'] as const) {
      expect(isValidHex(t[key])).toBe(true)
    }
  })

  it('picks a lighter cover scrim for light backgrounds, darker for dark', () => {
    expect(deriveCustomTheme('a', 'A', '#ffffff', '#000000', true).coverScrim).toBe('rgba(0,0,0,0.55)')
    expect(deriveCustomTheme('b', 'B', '#000000', '#ffffff', false).coverScrim).toBe('rgba(0,0,0,0.72)')
  })

  it('derives light text on dark bg and dark text on light bg', () => {
    const dark = deriveCustomTheme('d', 'D', '#101010', '#3b82f6', false)
    const light = deriveCustomTheme('l', 'L', '#fafafa', '#3b82f6', true)
    // crude luminance proxy: sum of channels
    const sum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
    expect(sum(dark.text)).toBeGreaterThan(sum(dark.bg)) // text lighter than dark bg
    expect(sum(light.text)).toBeLessThan(sum(light.bg)) // text darker than light bg
  })
})
