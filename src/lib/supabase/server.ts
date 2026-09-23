import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// During Docker builds, NEXT_PUBLIC_* vars are placeholder sentinels
// replaced at runtime by docker-entrypoint.sh.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const isBuildPlaceholder = url?.startsWith('__')
const safeUrl = isBuildPlaceholder ? 'https://placeholder.supabase.co' : url
const safeKey = isBuildPlaceholder ? 'placeholder' : key

/**
 * Cookie-session client for server components, server actions and routes.
 *
 * Cookie encoding stays the default `user-and-tokens` on purpose.
 * @supabase/ssr 0.12 offers an experimental `cookies.encode: 'tokens-only'`
 * that keeps the user object out of the cookie, but auth-js then substitutes a
 * THROWING proxy for `session.user` wherever no user store holds it: every
 * fresh server request (app/api/mcp-oauth/authorize/route.ts calls
 * `mfa.getAuthenticatorAssuranceLevel()`, which reads `session.user.factors`)
 * and, in the browser, every `getSession().user` read after a session minted
 * by the server-side PKCE callback (reset-password, SendInvoiceDialog) until
 * the next token refresh. The trust problem is solved at the consumers
 * instead: lib/supabase/middleware.ts and lib/auth/require-auth.ts never read
 * MFA state off the cookie's user object (factors come from getUser() or
 * listFactors(), the level from signature-verified claims). Switch the
 * encoding only together with those call sites, and identically here, in
 * client.ts and in middleware.ts: @supabase/ssr requires the two sides to
 * match.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    safeUrl,
    safeKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

export function createServiceClient() {
  // Stateless service-role client: no cookies.
  // Passing user session cookies causes @supabase/ssr to send the
  // user's JWT as the Authorization header, which overrides the
  // service role key and re-enables RLS. A cookie-less client
  // ensures the service role key is used for authorization,
  // properly bypassing RLS on every query.
  return createServerClient(
    safeUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )
}
