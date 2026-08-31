import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const log = createLogger('api/account/email')

const ChangeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
})

// How long a pending change is considered fresh enough that re-submitting the
// same address is a no-op instead of a re-send. Kept well under the token
// expiry so a user with a dead link can always get new mails.
const FRESH_PENDING_MS = 30 * 60 * 1000

/**
 * POST /api/account/email
 *
 * Server-routed login-email change. Always writes via the USER session so
 * Supabase's AAL2 guard fires: an email change is a credential rotation, and
 * a stolen AAL1 cookie must not be able to move the account to another
 * mailbox. (Contrast app/api/account/password/route.ts, whose first-time-set
 * path may bypass AAL2 because there is no existing credential to protect;
 * an email change always has one.)
 *
 * Nothing changes immediately: with secure email change enabled, Supabase
 * sends `email_change_current` to the old address and `email_change` to the
 * new one (templates in lib/email/auth-templates.ts via the send-email hook),
 * and the address flips only after confirmation. The links verify through
 * /auth/callback, which already handles type=email_change.
 *
 * The account itself is keyed by user id everywhere (company_members,
 * user_preferences, ...), so a confirmed change moves nothing but the login
 * identifier and contact address. profiles.email mirrors auth.users.email via
 * the sync_profile_email trigger (migration 20260828191950), so member lists,
 * notification recipients, and AGI/KU contact fields follow the change.
 */
export async function POST(request: Request) {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const result = await validateBody(request, ChangeEmailSchema)
  if (!result.success) return result.response
  const { email } = result.data

  if (user.email && email === user.email.toLowerCase()) {
    return NextResponse.json(
      { error: 'Det är redan din e-postadress.' },
      { status: 400 },
    )
  }

  // Re-requesting the address that is already awaiting confirmation is a
  // no-op success ONLY while the pending mails are fresh (protects the send
  // rate limit against double-clicks). Once they are older than that, the
  // confirmation links may have expired and the user's only recovery path is
  // re-running the change, so fall through to GoTrue, which restarts the
  // change and re-sends both mails. new_email/email_change_sent_at are absent
  // on the claims-mapped fast path; then GoTrue's own rate limit is the
  // backstop.
  if (user.new_email && email === user.new_email.toLowerCase()) {
    const sentAt = user.email_change_sent_at
      ? Date.parse(user.email_change_sent_at)
      : Number.NaN
    const fresh =
      Number.isFinite(sentAt) && Date.now() - sentAt < FRESH_PENDING_MS
    if (fresh) {
      return NextResponse.json({
        data: { ok: true, pending_email: email, resent: false },
      })
    }
  }

  // Trusted-origin resolution, not request.url: behind a proxy request.url
  // can be an internal origin (dead confirmation links on self-hosted), and
  // auth links may never follow an attacker-chosen host. Registered
  // white-label hosts pass through so the mail carries the right brand.
  const origin = resolveRequestAppOrigin(request)
  const { error: updateError } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: `${origin}/auth/callback` },
  )

  if (updateError) {
    log.warn('email change request failed', {
      userId: user.id,
      code: updateError.code,
      status: updateError.status,
    })
    // Addresses are unique per auth user: a change to an already-registered
    // address is refused by GoTrue, never merged. Accounts are consolidated
    // via company invitations, not email changes.
    if (
      updateError.code === 'email_exists' ||
      /already.*registered/i.test(updateError.message ?? '')
    ) {
      return NextResponse.json(
        { error: 'E-postadressen används redan av ett annat konto.' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      {
        error:
          getUserErrorMessage(updateError) ||
          'Kunde inte begära e-poständring. Försök igen.',
      },
      { status: 400 },
    )
  }

  log.info('email change requested', { userId: user.id })

  return NextResponse.json({
    data: { ok: true, pending_email: email, resent: true },
  })
}
