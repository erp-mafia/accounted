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
  // change and re-sends both mails.
  //
  // new_email/email_change_sent_at live on the GoTrue user, not in the JWT,
  // so they are absent on the claims-mapped fast path of requireAuth. Reading
  // them from the claims alone made every re-submit look like a brand-new
  // request: GoTrue re-issued both tokens and voided the links the user was
  // about to click, which is exactly the "link invalid" loop users hit after
  // pressing the button twice. Fetch the fresh user when the claims carry no
  // pending state; the extra round trip is fine on a route this rare.
  let pendingEmail = user.new_email
  let pendingSentAt = user.email_change_sent_at
  if (!pendingEmail) {
    const { data } = await supabase.auth.getUser()
    pendingEmail = data?.user?.new_email
    pendingSentAt = data?.user?.email_change_sent_at
  }

  if (pendingEmail && email === pendingEmail.toLowerCase()) {
    const sentAt = pendingSentAt ? Date.parse(pendingSentAt) : Number.NaN
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
  //
  // flow=email_change marks the callback so the stock GoTrue links (verified
  // on the GoTrue host, returned here via redirect_to with ?message=, ?error=
  // or ?code= instead of a token_hash) land on the email-change status page
  // rather than the silent login bounce. The Send Email hook preserves this
  // query on its token_hash links, so both link styles share the marker.
  const origin = resolveRequestAppOrigin(request)

  // Cross-instance gate (migration 20260903083000). The pending-state read
  // above is not atomic: two concurrent requests (two tabs, a retried fetch)
  // can both see nothing pending, and each updateUser re-issues the tokens
  // and voids the other's mails. claim_email_change_request is one
  // INSERT ... ON CONFLICT row lock per user, so exactly one caller per
  // address per window proceeds; the rest answer "already pending" and send
  // nothing. A different address always wins the claim. Best effort: if the
  // RPC itself fails, fall through to GoTrue rather than block the change.
  const { data: claimed, error: claimError } = await supabase.rpc(
    'claim_email_change_request',
    { p_email: email, p_window_seconds: FRESH_PENDING_MS / 1000 },
  )
  if (claimError) {
    log.warn('email change claim failed; proceeding without it', {
      userId: user.id,
      code: claimError.code,
    })
  } else if (claimed === false) {
    return NextResponse.json({
      data: { ok: true, pending_email: email, resent: false },
    })
  }

  const { error: updateError } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: `${origin}/auth/callback?flow=email_change` },
  )

  if (updateError) {
    log.warn('email change request failed', {
      userId: user.id,
      code: updateError.code,
      status: updateError.status,
    })
    // GoTrue sent nothing, so the claim must not block a retry (after MFA,
    // with another address, once the network is back).
    if (!claimError) {
      const { error: releaseError } = await supabase.rpc('release_email_change_request')
      if (releaseError) {
        log.warn('email change claim release failed', {
          userId: user.id,
          code: releaseError.code,
        })
      }
    }
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
