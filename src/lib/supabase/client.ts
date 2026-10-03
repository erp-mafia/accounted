import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import {
  getBrowserAccessToken,
  onBrowserAccessTokenChange,
} from '@/lib/supabase/browser-session-token'

// During Docker builds, NEXT_PUBLIC_* vars are placeholder sentinels
// (e.g. __NEXT_PUBLIC_SUPABASE_URL__) that get replaced at runtime by
// docker-entrypoint.sh. Provide a dummy URL so the client constructor
// doesn't throw during Next.js static page generation.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const isBuildPlaceholder = !url || url.startsWith('__')

/**
 * The browser Supabase client, WITHOUT an auth client.
 *
 * The session is server-held: an HttpOnly cookie that no script can read or
 * write (CASA 2.3.1/2.3.2, lib/supabase/cookie-options.ts). This client
 * therefore never holds a session. It is built with supabase-js's
 * `accessToken` option: PostgREST, Storage and Realtime send the short-lived
 * access token the server hands out at /api/auth/session-token
 * (lib/supabase/browser-session-token.ts), and supabase-js replaces
 * `supabase.auth` with an object that throws on any use.
 *
 * `auth` is removed from the TYPE as well, so the compiler rejects any
 * browser code that still reaches for it. Sign-in, sign-out, OTP, MFA and
 * user lookups go through the server routes in lib/auth/session-client.ts.
 */
export type BrowserSupabaseClient = SupabaseDataClient

let browserClient: BrowserSupabaseClient | null = null

function buildClient(): BrowserSupabaseClient {
  // supabase-js calls the accessToken callback once while constructing and
  // hands the result to realtime.setAuth(token). A non-null token there
  // marks it as MANUALLY set, which switches Realtime's own refresh off: it
  // would keep the first token on every channel until the JWT expired and
  // the server closed them. Answering null to that one construction-time
  // call makes Realtime fall back to the callback instead (realtime-js
  // _performAuth), and from then on it asks again on every heartbeat.
  let constructing = true
  const client = createBrowserClient(
    isBuildPlaceholder ? 'https://placeholder.supabase.co' : url,
    isBuildPlaceholder ? 'placeholder' : key,
    {
      // One client per page, managed here rather than by @supabase/ssr.
      isSingleton: false,
      accessToken: async () => (constructing ? null : getBrowserAccessToken()),
    },
  )
  constructing = false
  return client
}

export function createClient(): BrowserSupabaseClient {
  // Server rendering of client components: a throwaway client, no token.
  if (typeof window === 'undefined') return buildClient()
  if (browserClient) return browserClient

  const client = buildClient()
  browserClient = client
  // Push a rotated token to open channels right away instead of at the
  // next heartbeat. setAuth() without an argument re-reads the callback.
  onBrowserAccessTokenChange((token) => {
    if (token) void client.realtime.setAuth().catch(() => {})
  })
  return client
}
