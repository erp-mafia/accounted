import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { shouldEnforceMfa } from './mfa'
import type { JwtPayload, User, SupabaseClient } from '@supabase/supabase-js'
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
  // The signature-verified claims, kept for the MFA gate below: null on the
  // getUser fallback path, where no locally verified claims exist.
  let claims: JwtPayload | null = null
  try {
    // The typeof guard keeps legacy test mocks (auth object with only
    // getUser) on the old path.
    if (typeof supabase.auth.getClaims === 'function') {
      const { data } = await supabase.auth.getClaims()
      const verified = data?.claims
      if (verified?.sub) {
        if (claimsPinned(verified)) {
          claims = verified
          user = userFromClaims(verified)
        } else {
          console.error('requireAuth: getClaims iss/aud pinning failed; falling back to getUser', {
            iss: verified.iss,
            aud: verified.aud,
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

  if (shouldEnforceMfa(user) && !(await sessionIsMfaAssured(supabase, claims))) {
    return {
      user: null,
      supabase,
      error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
    }
  }

  return { user, supabase, error: null }
}

/**
 * Whether the session may pass the MFA gate.
 *
 * An AAL2 session, per the signature-verified claims, passes with no extra
 * round trip. Anything else (AAL1, no `aal` claim, or the getUser fallback
 * path where no verified claims exist) asks the auth server through
 * listFactors() (a getUser() call under the hood) whether a verified factor
 * exists: if one does, the session is stuck below the level it could reach
 * and is refused. A failed or throwing lookup is refused too (fail closed):
 * the alternative lets a transient auth error switch MFA off.
 *
 * Never `mfa.getAuthenticatorAssuranceLevel()` without a JWT: its `nextLevel`
 * is computed from `session.user.factors`, i.e. from the unsigned
 * sb-*-auth-token cookie, which whoever holds the password can edit to hide
 * the factor and turn an enrolled account into a "no MFA needed" one
 * (security audit 2026-09). The cost of the honest check is one listFactors
 * round trip per API request for AAL1 sessions of users without a factor.
 */
async function sessionIsMfaAssured(
  supabase: SupabaseClient,
  claims: JwtPayload | null,
): Promise<boolean> {
  if (claims?.aal === 'aal2') return true

  try {
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error || !data) {
      console.error('requireAuth: listFactors failed; treating session as not MFA-assured', error)
      return false
    }
    return !factorsIncludeVerified(data)
  } catch (err) {
    console.error('requireAuth: listFactors threw; treating session as not MFA-assured', err)
    return false
  }
}

type FactorList = ReadonlyArray<{ status: string }> | undefined

/**
 * Whether a listFactors() payload contains a verified factor of any type.
 * `all` carries every factor; the typed arrays carry only the verified ones.
 * Both are consulted so a payload missing either shape still reads right.
 */
function factorsIncludeVerified(data: {
  all?: FactorList
  totp?: FactorList
  phone?: FactorList
  webauthn?: FactorList
}): boolean {
  const verified = (list: FactorList) =>
    list?.some((factor) => factor.status === 'verified') ?? false
  return (
    verified(data.all) ||
    verified(data.totp) ||
    verified(data.phone) ||
    verified(data.webauthn)
  )
}
