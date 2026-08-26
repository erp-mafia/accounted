import type { JwtPayload, User } from '@supabase/supabase-js'

/**
 * Local JWT claims to a User: shared by the API route guard (require-auth),
 * the dashboard request context and, once adopted, the auth proxy.
 *
 * getClaims() verifies signature and expiry locally against the cached JWKS
 * (asymmetric signing keys; HS256 projects fall back to a server call inside
 * getClaims itself). These helpers add the pinning and the User mapping.
 */

/**
 * Defense-in-depth pinning on top of getClaims' signature/expiry verification:
 * the token must come from THIS project's auth server (iss) and be an
 * end-user access token (aud 'authenticated'; anonymous sign-ins share it).
 * A mismatch is not treated as unauthenticated: callers fall back to the
 * server-side getUser() check, which is authoritative.
 */
export function claimsPinned(claims: JwtPayload): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  // Without a configured URL (unit tests) there is nothing to pin against.
  const issOk = !supabaseUrl || claims.iss === `${supabaseUrl}/auth/v1`
  const aud = claims.aud
  const audOk = Array.isArray(aud) ? aud.includes('authenticated') : aud === 'authenticated'
  return issOk && audOk
}

/**
 * Maps verified JWT claims onto the User subset server code actually consumes
 * (id, email, is_anonymous, app_metadata, user_metadata, role, phone).
 *
 * Server-only fields (identities, factors, created_at timestamps) are absent
 * from the token and verified unused by any route (2026-07-23 audit);
 * created_at is set to '' only to satisfy the type.
 */
export function userFromClaims(claims: JwtPayload): User {
  return {
    id: claims.sub,
    aud: Array.isArray(claims.aud) ? (claims.aud[0] ?? 'authenticated') : (claims.aud ?? 'authenticated'),
    role: claims.role,
    email: claims.email,
    phone: claims.phone,
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
    is_anonymous: claims.is_anonymous ?? false,
    created_at: '',
  }
}
