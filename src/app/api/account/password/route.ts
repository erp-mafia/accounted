import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { userHasPassword } from '@/lib/auth/has-password'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const log = createLogger('api/account/password')

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Lösenordet måste vara minst 8 tecken')
    .refine(
      (v) =>
        /[a-z]/.test(v) &&
        /[A-Z]/.test(v) &&
        /[0-9]/.test(v) &&
        /[^a-zA-Z0-9]/.test(v),
      'Lösenordet måste innehålla versaler, gemener, siffror och specialtecken',
    ),
})

/**
 * POST /api/account/password
 *
 * Server-routed password set/change, then flips `app_metadata.has_password =
 * true` via the service client (clients can't write app_metadata).
 *
 * Two paths depending on whether the user already has a real password, as
 * userHasPassword (lib/auth/has-password.ts) defines it. One definition: an
 * email signup carries no flag and still knows its password.
 *
 *   - First-time set (no known password: `has_password: false`, or a
 *     BankID-linked user with no flag): write via the admin API. BankID-only
 *     users sit at AAL1 with a TOTP factor enrolled, and `updateUser` on the
 *     user session would be rejected with "AAL2 session is required to update
 *     email or password when MFA is enabled". Setting an initial password has
 *     no existing credential to protect, so bypassing AAL2 is safe. The
 *     admin write ends EVERY session of the user, this request's included
 *     (GoTrue signs the user out everywhere when a password is written with
 *     no session to keep), so the route hands the user a new one right after
 *     (restoreSession): without it the next request met a dead session and
 *     the user was bounced to /login seconds after choosing a password, on
 *     the way into MFA enrolment for most (13 users in two weeks, 2026-11).
 *
 *   - Change-password (a known password): write via the user session so
 *     Supabase's AAL2 guard still fires. A stolen AAL1 cookie must not be
 *     able to rotate a known password.
 *
 * This route is the single write path for setting a password. SecuritySettings,
 * the reset-password page, and the /account/set-password page all funnel
 * through here so the flag stays in sync: see lib/auth/has-password.ts.
 *
 * If the password update succeeds but the flag write fails, we log and still
 * return success: the user has a working password and the banner will show one
 * more time, but a retry will re-flip the flag.
 *
 * After a successful change every OTHER session of the user is ended (CASA
 * 2.2.2): GoTrue's logout with scope 'others', using this request's session,
 * which itself stays signed in. That covers the settings change, the
 * first-time set and the recovery flow (/reset-password posts here with the
 * recovery session), so a password reset also signs out whoever was using
 * the old one. A failed revocation is logged at error level and reported as
 * `otherSessionsEnded: false`; the password change itself stands. On a
 * first-time set the session it is called with is the restored one;
 * `sessionKept: false` says the restore failed, the password is saved and
 * the user has to sign in with it.
 */
export async function POST(request: Request) {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const result = await validateBody(request, SetPasswordSchema)
  if (!result.success) return result.response
  const { password } = result.data

  const isFirstTimeSet = !userHasPassword(user)
  const service = createServiceClient()

  let updateError:
    | { message?: string; status?: number; code?: string }
    | null
    | undefined = null

  if (isFirstTimeSet) {
    const { error } = await service.auth.admin.updateUserById(user.id, {
      password,
    })
    updateError = error
  } else {
    const { error } = await supabase.auth.updateUser({ password })
    updateError = error
  }

  if (updateError) {
    log.warn('password update failed', {
      userId: user.id,
      isFirstTimeSet,
      code: updateError.code,
      status: updateError.status,
    })
    return NextResponse.json(
      {
        error:
          getUserErrorMessage(updateError) ||
          'Kunde inte uppdatera lösenord. Försök igen.',
      },
      { status: 400 },
    )
  }

  // Read-merge-write so we don't wipe sibling app_metadata keys.
  // updateUserById replaces app_metadata wholesale (see lib/auth/has-password.ts
  // and the comment in app/api/account/delete/route.ts).
  let flagWriteOk = false
  try {
    const { data: u } = await service.auth.admin.getUserById(user.id)
    const prior = u?.user?.app_metadata ?? {}
    await service.auth.admin.updateUserById(user.id, {
      app_metadata: { ...prior, has_password: true },
    })
    flagWriteOk = true
  } catch (err) {
    log.error('failed to flip has_password flag after successful password set', {
      userId: user.id,
      err,
    })
    // Don't surface the failure: the user has a working password. The
    // banner will show once more and a retry will succeed.
  }

  // After the flag write, so the new session's token already says has_password.
  const sessionKept = isFirstTimeSet ? await restoreSession(service, supabase, user.id) : true

  // Without a session there is nothing to call GoTrue's logout with; the
  // admin write that cost the session ended the others with it.
  const otherSessionsEnded = sessionKept ? await endOtherSessions(supabase, user.id) : false

  log.info('password set', { userId: user.id, isFirstTimeSet, flagWriteOk, otherSessionsEnded, sessionKept })

  return NextResponse.json({ data: { ok: true, otherSessionsEnded, sessionKept } })
}

type RouteSupabase = Awaited<ReturnType<typeof requireAuth>>['supabase']

/**
 * A new session for the user whose sessions the admin password write just
 * ended, minted the way the BankID sign-in mints one: a magic link from the
 * admin API, verified at once on this request's client, which writes the
 * session cookie onto the response. Not a password sign-in: that door is the
 * login route's, with its captcha and its limits. Returns whether the user
 * is signed in again.
 *
 * The link is minted for the address the auth server holds for this user id,
 * read now, never for the one in the request's token: that one can be an hour
 * old, and after an e-mail change it names nobody (GoTrue would create an
 * account for it) or somebody else. A link that came back for another user is
 * thrown away unverified.
 */
async function restoreSession(
  service: ReturnType<typeof createServiceClient>,
  supabase: RouteSupabase,
  userId: string,
): Promise<boolean> {
  try {
    const { data: current } = await service.auth.admin.getUserById(userId)
    const email = current?.user?.email
    if (!email) {
      log.error('no session after a first-time password set: the user has no e-mail to mint one for', { userId })
      return false
    }
    const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: 'magiclink', email })
    const tokenHash = link?.properties?.hashed_token
    if (linkError || !tokenHash) {
      log.error('no session after a first-time password set: minting the link failed', {
        userId,
        code: linkError?.code,
        status: linkError?.status,
      })
      return false
    }
    if (link.user?.id !== userId) {
      log.error('no session after a first-time password set: the link was minted for another user', { userId })
      return false
    }
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
    if (error || !data?.session) {
      log.error('no session after a first-time password set: verifying the link failed', {
        userId,
        code: error?.code,
        status: error?.status,
      })
      return false
    }
    return true
  } catch (err) {
    log.error('no session after a first-time password set: restoring it threw', { userId, err })
    return false
  }
}

/**
 * Revoke every session of the user except the one making this request.
 * Returns whether GoTrue confirmed it.
 */
async function endOtherSessions(
  supabase: RouteSupabase,
  userId: string,
): Promise<boolean> {
  try {
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (error) {
      log.error('ending other sessions after a password change failed', {
        userId,
        code: error.code,
        status: error.status,
      })
      return false
    }
    return true
  } catch (err) {
    log.error('ending other sessions after a password change threw', { userId, err })
    return false
  }
}
