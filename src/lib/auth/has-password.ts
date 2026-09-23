import type { User } from '@supabase/supabase-js'

/**
 * True iff the user has set a password they actually know.
 *
 * Source of truth: `app_metadata.has_password` (server-only, set by us: clients
 * cannot fake it through `updateUser`).
 *
 * - BankID signup writes `has_password: false` (they got a random server-side
 *   password they will never see).
 * - Email/password signup doesn't set the flag: we infer `true` because the
 *   user supplied a password to reach signUp at all.
 * - The flag flips to `true` after a successful POST /api/account/password.
 */
export function userHasPassword(user: Pick<User, 'app_metadata'>): boolean {
  const meta = user.app_metadata ?? {}
  if (meta.has_password === true) return true
  if (meta.has_password === false) return false
  return meta.bankid_linked !== true
}
