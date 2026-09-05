/**
 * Session minting for BankID accounts whose typed address is still unproven
 * (`app_metadata.bankid_pending`, see bankid-pending.ts).
 *
 * BankID instant login (2026-09-05): the signup and the login of a pending
 * identity sign the holder in at once; the confirmation mail keeps flowing
 * but nothing waits for it. The address is what the mail proves, not the
 * person, and BankID already proved the person.
 *
 * Why a password grant and not the magic link the verified login uses:
 * GoTrue keeps ONE magic-link token per user, so minting a login link would
 * invalidate the verification mail in flight (and every later BankID login
 * would kill the outstanding mail again). The BankID signup gives the account
 * a random server-side password the holder never sees (has_password: false);
 * rotating it and exchanging it for a session touches no token slot, so the
 * mailed link stays valid however often the holder signs in. GoTrue refuses
 * the password grant for an unconfirmed address, so the address is marked
 * confirmed on the GoTrue side here: our own verification state lives in
 * bankid_identities.email_verified_at plus the bankid_pending flag, which is
 * what /auth/callback, the MFA gate and the invite acceptance read.
 *
 * Rollback: BANKID_SIGNUP_REQUIRE_EMAIL_CONFIRMATION=true restores the
 * mail-gated flow (no session until the mailed link is clicked).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { flagEnabled } from '@/lib/env/public-flags'
import { createLogger } from '@/lib/logger'

const log = createLogger('tic/bankid-session-grant')

/** True when the operator has switched instant login OFF (mail-gated flow). */
export function signupRequiresMailConfirmation(): boolean {
  return flagEnabled(process.env.BANKID_SIGNUP_REQUIRE_EMAIL_CONFIRMATION)
}

export interface MintedSession {
  accessToken: string
  refreshToken: string
}

export type MintPendingSessionResult =
  | { ok: true; session: MintedSession }
  | { ok: false; step: 'rotate_password' | 'password_grant'; message?: string }

/**
 * Sign a pending BankID account in without touching any GoTrue token slot.
 *
 * `supabase` is the service-role client (auth.admin). The returned tokens are
 * handed to the browser, which installs them with setSession(); same trust
 * level as the hashed magic-link token the verified login returns.
 */
export async function mintPendingSession(
  supabase: SupabaseClient,
  userId: string,
  email: string,
): Promise<MintPendingSessionResult> {
  const password = crypto.randomBytes(32).toString('base64url')

  const { error: rotateError } = await supabase.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
  })
  if (rotateError) {
    log.error('could not rotate the server-side password of a pending bankid account', {
      userId,
      code: rotateError.code,
      message: rotateError.message,
    })
    return { ok: false, step: 'rotate_password', message: rotateError.message }
  }

  // Throwaway anon-key client: the service client must not adopt the
  // session, and the SSR client would write cookies for a response we do
  // not own. The factory pins persistSession/autoRefreshToken off (no leaked
  // refresh ticker); the anon key is what the token endpoint expects.
  const grant = createServiceRoleClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { detectSessionInUrl: false } },
  )
  const { data, error: grantError } = await grant.auth.signInWithPassword({ email, password })
  if (grantError || !data.session) {
    log.error('password grant failed for a pending bankid account', {
      userId,
      code: grantError?.code,
      message: grantError?.message,
    })
    return { ok: false, step: 'password_grant', message: grantError?.message }
  }

  return {
    ok: true,
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    },
  }
}
