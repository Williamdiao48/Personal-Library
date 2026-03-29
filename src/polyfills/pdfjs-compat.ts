/**
 * Polyfills for pdfjs-dist v5 compatibility with Electron 31 (Chromium 126).
 * These APIs landed in Chromium 128 and are used throughout pdfjs v5.
 * This file is imported in both the main thread and the worker thread.
 */

// ── Promise.try ───────────────────────────────────────────────────────────────
// Used in MessageHandler to dispatch action handlers: Promise.try(fn, ...args).
// The args must be forwarded or handlers receive undefined arguments.
if (typeof (Promise as unknown as { try?: unknown }).try !== 'function') {
  Object.defineProperty(Promise, 'try', {
    value<T>(fn: (...a: unknown[]) => T | PromiseLike<T>, ...args: unknown[]): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        try { resolve(fn(...args)) } catch (e) { reject(e) }
      })
    },
    writable: true, configurable: true,
  })
}

// ── Uint8Array.prototype.toHex ────────────────────────────────────────────────
// Used for PDF fingerprint generation.
if (typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value(this: Uint8Array): string {
      let out = ''
      for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0')
      return out
    },
    writable: true, configurable: true,
  })
}

// ── Uint8Array.prototype.toBase64 ─────────────────────────────────────────────
// Used for inline image data URLs and document export.
if (typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value(this: Uint8Array): string {
      let binary = ''
      for (let i = 0; i < this.length; i++) binary += String.fromCharCode(this[i])
      return btoa(binary)
    },
    writable: true, configurable: true,
  })
}

// ── Uint8Array.fromBase64 ─────────────────────────────────────────────────────
// Used for decoding signature data.
if (typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 !== 'function') {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value(s: string): Uint8Array {
      const binary = atob(s)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    },
    writable: true, configurable: true,
  })
}
