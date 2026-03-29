import type { CustomTheme } from '../contexts/SettingsContext'

// ── Hex <-> RGB helpers ──────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

/** Shift a hex color toward white (positive amount) or black (negative). */
function shift(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r + amount, g + amount, b + amount)
}

/** Blend two hex colors. ratio=1 → 100% a, ratio=0 → 100% b */
function blend(a: string, b: string, ratio: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  return rgbToHex(
    ar * ratio + br * (1 - ratio),
    ag * ratio + bg * (1 - ratio),
    ab * ratio + bb * (1 - ratio),
  )
}

/** Relative luminance (0–1) for contrast calculations. */
function luminance(hex: string): number {
  return hexToRgb(hex).reduce((acc, c, i) => {
    const v = c / 255
    const linear = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    return acc + linear * [0.2126, 0.7152, 0.0722][i]
  }, 0)
}

/** Darken a hex color by reducing each channel by a fraction. */
function darken(hex: string, fraction: number): string {
  const [r, g, b] = hexToRgb(hex)
  return rgbToHex(r * (1 - fraction), g * (1 - fraction), b * (1 - fraction))
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Derive all theme variables from the three seed values the user picks.
 * Returns a complete CustomTheme (minus id and name, which the caller sets).
 */
export function deriveCustomTheme(
  id:      string,
  name:    string,
  bg:      string,
  accent:  string,
  isLight: boolean,
): CustomTheme {
  const shiftAmt = isLight ? -10 : 10   // surface shifts darker for light, lighter for dark

  const bgSurface  = shift(bg, shiftAmt)
  const bgHover    = shift(bg, shiftAmt * 2)
  const border     = blend(bg, bgSurface, 0.4)
  const text       = isLight ? darken(bg, 0.88) : shift(bg, 180)
  const textMuted  = blend(text, bg, 0.5)
  const accentDim  = darken(accent, 0.25)
  const lum        = luminance(bg)
  const coverScrim = lum > 0.3
    ? 'rgba(0,0,0,0.55)'
    : 'rgba(0,0,0,0.72)'

  return {
    id, name, bg, accent, isLight,
    bgSurface, bgHover, border,
    text, textMuted, accentDim, coverScrim,
  }
}

/** Returns true if the hex string is a valid 6-digit color. */
export function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex)
}
