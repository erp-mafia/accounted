import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { shouldEnforceMfa } from './mfa'
import type { User, SupabaseClient } from '@supabase/supabase-js'
import { claimsPinned, userFromClaims } from './claims'

type AuthResult =
  | { user: User; supabase: SupabaseClient; error: null }
  | { user: null; supabase: SupabaseClient; error: NextResponse }

// claimsPinned / userFromClaims live in ./claims so the dashboard request
// context (and later the auth proxy) share the exact same pinning + mapping.

/**
 * Auth + MFA guard for API routes.
 *
 * Returns the authenticated user and Supabase client, or a JSON error response.
 * When MFA is required (hosted deployment), verifies AAL2 assurance level.
 *
 * Fast path: getClaims() performs local WebCrypto verification against the
 * shared 10-minute JWKS cache instead of a per-request network getUser()
 * round trip. HS256/self-hosted projects fall back to a server call inside
 * getClaims itself (identical semantics; NEXT_PUBLIC_SELF_HOSTED needs no
 * special-casing). Revocation is still checked on every request by proxy.ts
 * middleware getUser() before any route runs. Claims-sourced metadata
 * (email, app_metadata, is_anonymous) can be up to one access-token TTL
 * stale, which is acceptable for all current consumers: bankid_linked
 * staleness is covered because the middleware MFA gate
 * (lib/supabase/middleware.ts) uses the FRESH getUser result.
 */
export async function requireAuth(): Promise<AuthResult> {
  const supabase = await createClient()

  let user: User | null = null
  try {
    // The typeof guard keeps legacy test mocks (auth object with only
    // getUser) on the old path.
    if (typeof supabase.auth.getClaims === 'function') {
      const { data } = await supabase.auth.getClaims()
      const claims = data?.claims
      if (claims?.sub) {
        if (claimsPinned(claims)) {
          user = userFromClaims(claims)
        } else {
          console.error('requireAuth: getClaims iss/aud pinning failed; falling back to getUser', {
            iss: claims.iss,
            aud: claims.aud,
          })
        }
      }
    }
  } catch (err) {
    // JWKS outage or malformed token: fall through to the server-side check.
    // Logged because every hit here degrades the request to the slower
    // getUser round trip; a spike must be visible in production.
    console.error('requireAuth: getClaims failed; falling back to getUser', err)
  }
  if (!user) {
    const { data } = await supabase.auth.getUser()
    user = data?.user ?? null
  }

  if (!user) {
    return {
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  if (shouldEnforceMfa(user)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
      }
    }
  }

  return { user, supabase, error: null }
}
