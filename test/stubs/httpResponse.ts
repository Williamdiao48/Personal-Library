// Minimal fake `Response` builders for tests that stub the global `fetch`
// (scribblehub's WordPress AJAX TOC, wattpad's JSON API v3). Only the surface the
// parsers touch is implemented: `ok`, `status`, `statusText`, `text()`, `json()`.
// Pair with `vi.stubGlobal('fetch', vi.fn())` + `vi.unstubAllGlobals()` in afterEach.

export interface FakeResponse {
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
  json: () => Promise<unknown>
}

/** A 200 response whose body is `html` (both text() and a JSON.parse of it). */
export function okText(html: string): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => html,
    json: async () => JSON.parse(html),
  }
}

/** A 200 response whose body is `obj` (json() returns it; text() stringifies). */
export function okJson(obj: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  }
}

/** A non-2xx response. `ok` is false so parsers hit their error branch. */
export function notOk(status: number, statusText = 'Error'): FakeResponse {
  return {
    ok: false,
    status,
    statusText,
    text: async () => '',
    json: async () => ({}),
  }
}
