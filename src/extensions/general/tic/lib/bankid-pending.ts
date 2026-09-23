/**
 * Pending BankID identities (security audit 2026-09, account pre-hijacking).
 *
 * A BankID signup creates the auth user for whatever address the caller typed.
 * Until that address is proven (the confirmation mail is clicked and
 * /auth/callback promotes the row), the `bankid_identities` row carries
 * `email_verified_at IS NULL` and the auth user carries
 * `app_metadata.bankid_pending: true` instead of `bankid_linked: true`. A
 * pending identity must never sign anyone in, and it must never be promoted
 * once the account has been adopted through another credential (the real
 * owner of the address set a password or signed in with Google).
 *
 * The promotion side lives in app/(auth)/auth/callback/route.ts (core, so it
 * cannot import this module); `hasForeignCredential` there mirrors the one
 * here on purpose. Keep the two in step.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('tic/bankid-pending')

/** The subset of the auth user the adoption checks read. */
export type AdoptionUser = Pick<User, 'identities' | 'app_metadata' | 'email_confirmed_at'>

/**
 * True when the account has a credential the BankID signup never created:
 * a non-email identity (Google) or a password the user set themselves
 * (`has_password: true`, written only by POST /api/account/password). Either
 * one means somebody proved ownership of the address by other means, and the
 * pending BankID identity must be revoked rather than promoted.
 */
export function hasForeignCredential(user: AdoptionUser): boolean {
  const identities = user.identities ?? []
  if (identities.some((identity) => identity.provider !== 'email')) return true
  return user.app_metadata?.has_password === true
}

/**
 * True when the pending account is still exactly what the BankID signup made:
 * address unconfirmed, no foreign credential. Only such an account may be
 * deleted outright when the same BankID signs up again (typo'd address, lost
 * mail): nobody else has a stake in it yet.
 */
export function isUnadoptedPendingAccount(user: AdoptionUser): boolean {
  return !user.email_confirmed_at && !hasForeignCredential(user)
}

/**
 * Remove the pending BankID link from an account that somebody else now owns:
 * delete the unverified identity row(s) and drop `bankid_pending` from
 * app_metadata. `bankid_linked` is untouched (a pending signup never set it).
 * Read-merge-write on app_metadata, like every other writer in this
 * extension. Returns false when the row delete failed; the flag update is
 * best-effort.
 */
export async function revokePendingIdentity(
  supabase: SupabaseClient,
  userId: string,
  priorAppMetadata: Record<string, unknown> | undefined,
): Promise<boolean> {
  const { error: deleteError } = await supabase
    .from('bankid_identities')
    .delete()
    .eq('user_id', userId)
    .is('email_verified_at', null)

  if (deleteError) {
    log.error('could not revoke pending bankid identity', {
      userId,
      code: deleteError.code,
      message: deleteError.message,
    })
    return false
  }

  const { error: metaError } = await supabase.auth.admin.updateUserById(userId, {
    // null removes the key under GoTrue's merge semantics and is falsy if the
    // metadata is ever replaced wholesale instead.
    app_metadata: { ...(priorAppMetadata ?? {}), bankid_pending: null },
  })
  if (metaError) {
    log.error('could not clear bankid_pending after revoking identity', {
      userId,
      code: metaError.code,
      message: metaError.message,
    })
  }
  return true
}
