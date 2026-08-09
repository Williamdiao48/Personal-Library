// ─────────────────────────────────────────────────────────────────────────────
// realtime — the push-side "wake up and pull" signal.
//
// The sync engine's PULL side otherwise only fires on the 2-minute poll, so a
// change made on device A is invisible on device B for up to two minutes. This
// module subscribes to Postgres `postgres_changes` on the user's synced rows so
// the instant another device (or another session) writes, this device pulls
// within a debounce window instead of waiting out the poll.
//
// RLS still applies per row on the server side (the realtime auth token is the
// user's own JWT), so a device only ever receives events for its own rows. We
// ignore the payload entirely — the event is purely a "something changed, go
// pull" nudge, so no `REPLICA IDENTITY FULL` / trusted-payload handling is needed
// and the whole thing degrades to the poll if the socket can't connect.
//
// Dumb controller by design: it owns only the channel lifecycle and takes the
// `onChange` nudge as a callback, so it has NO dependency on syncService (which
// drives it). That keeps syncService the single owner of the enabled/signed-in
// state machine and avoids an import cycle.
// ─────────────────────────────────────────────────────────────────────────────

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

// The one channel for this session. Null when we're not subscribed (signed out,
// sync disabled, or cloud unconfigured).
let channel: RealtimeChannel | null = null

const CHANNEL_NAME = 'library-sync'

/**
 * Start (or refresh the auth token of) the realtime subscription.
 *
 * `setAuth` is always called so a token refresh keeps RLS filtering working
 * across the hourly JWT rotation. If a channel already exists we ONLY refresh the
 * token — we never open a second subscription. `onChange` fires on every
 * INSERT/UPDATE/DELETE to any synced table in `public` that RLS lets this user
 * see; the caller debounces it into a pull.
 */
export function startRealtime(
  supabase: SupabaseClient,
  accessToken: string,
  onChange: () => void,
): void {
  // Point realtime at the user's JWT so postgres_changes are RLS-filtered to their
  // own rows (and stay valid after a token refresh). Fire-and-forget: a failure
  // here just means events may not flow, which degrades to the poll.
  void supabase.realtime.setAuth(accessToken)
  if (channel) return // already subscribed; the setAuth above refreshed the token

  channel = supabase
    .channel(CHANNEL_NAME)
    // No `table` filter → every table in the publication. We don't care which
    // table or what changed, only that we should pull.
    .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
      // Visibility while we validate the feature end-to-end: which table fired.
      console.log(`[realtime] change on ${payload.table} (${payload.eventType}) → pull`)
      onChange()
    })
    .subscribe((status, err) => {
      // Surface the connection outcome so a silently-dead subscription (bad token,
      // table not in the publication, socket blocked) is visible rather than just
      // "realtime doesn't work". SUBSCRIBED = we're live; the rest are failures.
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] subscribed — live pull on server changes')
      } else {
        console.warn(`[realtime] channel status: ${status}${err ? ` — ${err.message}` : ''}`)
      }
    })
}

/** Tear down the subscription (sign-out / sync disabled). Safe to call twice. */
export function stopRealtime(supabase: SupabaseClient | null): void {
  if (!channel) return
  const ch = channel
  channel = null
  // unsubscribe() closes the topic; removeChannel drops it from the client's list
  // so a later start() opens a genuinely fresh one.
  void ch.unsubscribe()
  supabase?.removeChannel(ch)
}

/** True when a realtime subscription is currently open (for status/tests). */
export function isRealtimeActive(): boolean {
  return channel !== null
}

/** Test-only: drop the module's channel handle without a client round-trip. */
export function __resetRealtimeForTest(): void {
  channel = null
}
