import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const log = createLogger('api/account/email')

const ChangeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().max(320).pipe(z.string().email()),
})

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
 * identifier and contact address.
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

  const origin = new URL(request.url).origin
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

  return NextResponse.json({ data: { ok: true, pending_email: email } })
}
