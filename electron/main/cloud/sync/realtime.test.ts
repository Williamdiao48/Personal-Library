import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { startRealtime, stopRealtime, isRealtimeActive, __resetRealtimeForTest } from './realtime'

// realtime is a thin lifecycle controller over the Supabase client's channel API.
// A hand-rolled fake stands in for the client so these run with no socket: it
// records setAuth/subscribe/unsubscribe and captures the postgres_changes handler
// so a test can fire a synthetic change event.

function makeFakeClient(): {
  client: SupabaseClient
  setAuth: ReturnType<typeof vi.fn>
  subscribeCount: () => number
  unsubscribe: ReturnType<typeof vi.fn>
  removeChannel: ReturnType<typeof vi.fn>
  fireChange: () => void
  fireStatus: (status: string, err?: Error) => void
} {
  let handler: ((payload: unknown) => void) | null = null
  let statusCb: ((status: string, err?: Error) => void) | null = null
  let subscribeCount = 0
  const setAuth = vi.fn(async () => {})
  const unsubscribe = vi.fn(async () => 'ok')
  const removeChannel = vi.fn()

  const channel = {
    on: vi.fn((_event: string, _filter: unknown, cb: (payload: unknown) => void) => {
      handler = cb
      return channel
    }),
    subscribe: vi.fn((cb?: (status: string, err?: Error) => void) => {
      subscribeCount++
      statusCb = cb ?? null
      return channel
    }),
    unsubscribe,
  }

  const client = {
    realtime: { setAuth },
    channel: vi.fn(() => channel),
    removeChannel,
  } as unknown as SupabaseClient

  return {
    client,
    setAuth,
    subscribeCount: () => subscribeCount,
    unsubscribe,
    removeChannel,
    // Real payloads carry table/eventType — the handler logs them, so supply a shape.
    fireChange: () => handler?.({ table: 'items', eventType: 'UPDATE' }),
    fireStatus: (status: string, err?: Error) => statusCb?.(status, err),
  }
}

beforeEach(() => {
  __resetRealtimeForTest()
})

describe('startRealtime', () => {
  it('sets the auth token, subscribes once, and nudges onChange on a server change', () => {
    const f = makeFakeClient()
    const onChange = vi.fn()

    startRealtime(f.client, 'jwt-1', onChange)

    expect(f.setAuth).toHaveBeenCalledWith('jwt-1')
    expect(f.subscribeCount()).toBe(1)
    expect(isRealtimeActive()).toBe(true)

    // A synthetic postgres_changes event fires our pull nudge.
    f.fireChange()
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('logs the subscription outcome (SUBSCRIBED vs a failure status)', () => {
    const f = makeFakeClient()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    startRealtime(f.client, 'jwt-1', vi.fn())

    f.fireStatus('SUBSCRIBED')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('subscribed'))

    f.fireStatus('CHANNEL_ERROR', new Error('boom'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CHANNEL_ERROR'))

    log.mockRestore()
    warn.mockRestore()
  })

  it('a second start only refreshes the token — never opens a second subscription', () => {
    const f = makeFakeClient()
    startRealtime(f.client, 'jwt-1', vi.fn())
    startRealtime(f.client, 'jwt-2', vi.fn())

    expect(f.subscribeCount()).toBe(1) // still one channel
    expect(f.setAuth).toHaveBeenLastCalledWith('jwt-2') // token refreshed
  })
})

describe('stopRealtime', () => {
  it('unsubscribes + removes the channel and lets a fresh start re-subscribe', () => {
    const f = makeFakeClient()
    startRealtime(f.client, 'jwt-1', vi.fn())

    stopRealtime(f.client)

    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(f.removeChannel).toHaveBeenCalledTimes(1)
    expect(isRealtimeActive()).toBe(false)

    // A later start opens a genuinely new subscription.
    startRealtime(f.client, 'jwt-2', vi.fn())
    expect(f.subscribeCount()).toBe(2)
  })

  it('is a no-op when nothing is subscribed', () => {
    const f = makeFakeClient()
    stopRealtime(f.client)
    expect(f.unsubscribe).not.toHaveBeenCalled()
    expect(f.removeChannel).not.toHaveBeenCalled()
  })
})
