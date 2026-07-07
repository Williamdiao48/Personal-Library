// Message contract shared between the main-process host (embed-host.ts) and the
// sandboxed embed-worker child. Types only — no imports, no runtime code — so it
// is safe to pull into the Electron-free worker bundle.
//
// Vectors cross the boundary as plain number[][] (not Float32Array[]) — trivially
// structured-cloneable across any Electron version; the host reconstitutes
// Float32Array. `result` (not `vectors`) so the shape settles the generic
// PendingRegistry directly.

export type EmbedRequest = { id: number; texts: string[] }

export type EmbedResponse =
  { id: number; ok: true; result: number[][] } | { id: number; ok: false; error: string }
