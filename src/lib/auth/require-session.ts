import 'server-only'

import type { NextResponse } from 'next/server'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { authError } from '@/lib/auth/auth-route-helpers'

type SessionResult =
  | { user: User; supabase: SupabaseClient; error: null }
  | { user: null; supabase: SupabaseClient; error: NextResponse }

/**
 * Authenticate the cookie session WITHOUT the AAL2 gate.
 *
 * Only for the routes that exist to reach AAL2 or to describe the session
 * to its own auth pages: MFA status/enrol/verify/unenrol and /api/auth/me.
 * They run on /mfa/verify, /mfa/enroll, /account/set-password and
 * /reset-password, where the session is AAL1 by definition (the proxy lets
 * those pages through at AAL1 for the same reason, and lists these paths in
 * apiPathSkipsMfaGate). Every other route uses requireAuth() or
 * withRouteContext, which enforce the gate.
 *
 * getUser() rather than local claims: a server round trip that checks the
 * session is still live and returns the authoritative factor list.
 */
export async function requireSessionAllowingAal1(): Promise<SessionResult> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) {
    return {
      user: null,
      supabase,
      error: authError(401, 'unauthorized', 'Du är inte inloggad.', 'You are not signed in.'),
    }
  }
  return { user, supabase, error: null }
}

/** Whether a server-authenticated user record carries a verified factor. */
export function hasVerifiedFactor(user: Pick<User, 'factors'>): boolean {
  return user.factors?.some((factor) => factor.status === 'verified') ?? false
}
