import type { RealtimeChannel } from '@supabase/supabase-js'
import type { BrowserSupabaseClient } from '@/lib/supabase/client'
import { getBrowserAccessToken } from '@/lib/supabase/browser-session-token'

/**
 * Join a postgres_changes channel as the signed-in user, or not at all.
 *
 * realtime-js puts the access token into the join message only when it
 * already holds one at subscribe() time; the browser client fetches its token
 * asynchronously (lib/supabase/browser-session-token.ts), and a channel that
 * joins before that answer (or after a failed one) joins with the anon key.
 * Realtime then runs its per-change RLS check as `anon`, the SELECT policies
 * call user_company_ids(), which anon may not execute, and the whole WAL poll
 * (realtime.list_changes) fails for every subscriber on the project, not just
 * this tab. Production logged thousands of those failed polls a day.
 *
 * So: wait for the token, hand it to the realtime client, then subscribe. No
 * token (no session, MFA step-up owed) means no channel; the page falls back
 * to its own fetches. Returns a cancel function for the effect cleanup, so a
 * channel removed while the token was on its way is never joined.
 */
export function subscribeAsUser(supabase: BrowserSupabaseClient, channel: RealtimeChannel): () => void {
  let cancelled = false
  void (async () => {
    const token = await getBrowserAccessToken()
    if (cancelled || !token) return
    try {
      // Without an argument setAuth() re-reads the client's token callback,
      // which answers from the cache just filled above.
      await supabase.realtime.setAuth()
    } catch {
      // Safe to ignore: without the token handed over the channel stays
      // unjoined (never anon) and the page keeps working from its own fetches.
      return
    }
    if (cancelled) return
    channel.subscribe()
  })()
  return () => {
    cancelled = true
  }
}
