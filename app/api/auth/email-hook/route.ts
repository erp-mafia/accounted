import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'
import { getEmailService } from '@/lib/email/service'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { getSenderForBrand } from '@/lib/email/brand-sender'
import { buildAuthEmail } from '@/lib/email/auth-templates'
import { verifyStandardWebhookSignature } from '@/lib/email/standard-webhook'

// Loads the email extension so getEmailService() returns the Resend
// implementation instead of the noop default.
ensureInitialized()

const log = createLogger('auth-email-hook')

/**
 * POST /api/auth/email-hook: Supabase Auth "Send Email" hook (WL-05, WL-13).
 *
 * When enabled in Supabase (Auth > Hooks > Send Email, pointing at this URL
 * with the shared secret in SUPABASE_SEND_EMAIL_HOOK_SECRET), Supabase stops
 * sending auth mail itself and this endpoint sends every auth mail (signup
 * confirmation, recovery, magic link, invite, email change, reauthentication)
 * through the platform email service, branded per the requesting host: the
 * brand is resolved from the redirect_to origin via resolveBrandByHost, so a
 * reset requested on app.partner.se is sent in the partner's brand and links
 * back to app.partner.se. Unknown hosts get canonical platform mail.
 *
 * Unauthenticated by design (server-to-server): authenticity comes from the
 * Standard Webhooks signature, not a session, exactly like the Stripe and
 * Resend webhook routes. The raw body is verified byte-for-byte before
 * parsing. This endpoint is availability-critical once the hook is enabled:
 * any internal failure returns 500 so Supabase retries (up to 3 times within
 * a 5 second budget); success returns 200 {} fast.
 *
 * Until the hook is switched on in Supabase this route is dormant and auth
 * mail keeps flowing from Supabase unchanged.
 */

// verifyOtp types our /auth/callback confirm route accepts. Unknown action
// types fall back to the generic 'email' type rather than dropping the mail.
const VERIFY_TYPES = new Set([
  'signup',
  'recovery',
  'magiclink',
  'invite',
  'email_change',
  'email',
])

interface SendEmailHookPayload {
  user?: {
    email?: string | null
    new_email?: string | null
    email_new?: string | null
  } | null
  email_data?: {
    token?: string
    token_hash?: string
    token_new?: string
    token_hash_new?: string
    redirect_to?: string
    email_action_type?: string
    site_url?: string
  } | null
}

/**
 * Build the verify URL on the ORIGINATING host using the token_hash +
 * verifyOtp pattern (browser- and host-independent, per the WL-05 research):
 * /auth/callback consumes token_hash + type server-side and then honors the
 * `next` path. If redirect_to already points at /auth/callback (our client
 * flows do), its query (e.g. next=/reset-password) is preserved.
 */
function buildActionUrl(
  redirectUrl: URL | null,
  tokenHash: string,
  actionType: string,
): string {
  const verifyType = VERIFY_TYPES.has(actionType) ? actionType : 'email'
  let url: URL
  if (redirectUrl && redirectUrl.pathname === '/auth/callback') {
    url = new URL(redirectUrl.toString())
  } else {
    url = new URL('/auth/callback', redirectUrl ? redirectUrl.origin : getBranding().appUrl)
    if (redirectUrl) {
      const next = redirectUrl.pathname + redirectUrl.search
      if (next && next !== '/') url.searchParams.set('next', next)
    }
  }
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', verifyType)
  return url.toString()
}

export async function POST(request: Request) {
  const secret = process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET
  if (!secret) {
    log.error('SUPABASE_SEND_EMAIL_HOOK_SECRET is not configured', undefined)
    return NextResponse.json({ error: 'Hook not configured' }, { status: 500 })
  }

  const rawBody = await request.text()
  const verified = verifyStandardWebhookSignature({
    secret,
    payload: rawBody,
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
  })
  if (!verified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: SendEmailHookPayload
  try {
    payload = JSON.parse(rawBody) as SendEmailHookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const emailData = payload.email_data ?? {}
  const actionType = emailData.email_action_type || ''
  const recipient = payload.user?.email || null
  if (!recipient) {
    return NextResponse.json({ error: 'Missing recipient' }, { status: 400 })
  }

  // Brand from the requesting host: redirect_to carries the tenant origin.
  let redirectUrl: URL | null = null
  if (emailData.redirect_to) {
    try {
      redirectUrl = new URL(emailData.redirect_to)
    } catch {
      redirectUrl = null
    }
  }
  const brand = redirectUrl ? await resolveBrandByHost(redirectUrl.hostname) : null
  const sender = getSenderForBrand(brand)
  const appName = brand?.appName ?? getBranding().appName

  // Compose the mail(s) for this hook invocation.
  const mails: Array<{ to: string; actionType: string; actionUrl?: string; otpCode?: string }> = []

  if (actionType === 'reauthentication') {
    if (!emailData.token) {
      return NextResponse.json({ error: 'Missing token' }, { status: 400 })
    }
    mails.push({ to: recipient, actionType, otpCode: emailData.token })
  } else if (actionType === 'email_change') {
    // Secure email change sends TWO mails from one invocation. Documented
    // reversal: token_hash confirms at the NEW address, token_hash_new at
    // the CURRENT one.
    if (!emailData.token_hash) {
      return NextResponse.json({ error: 'Missing token_hash' }, { status: 400 })
    }
    const newEmail = payload.user?.new_email || payload.user?.email_new || recipient
    mails.push({
      to: newEmail,
      actionType: 'email_change',
      actionUrl: buildActionUrl(redirectUrl, emailData.token_hash, 'email_change'),
    })
    if (emailData.token_hash_new) {
      mails.push({
        to: recipient,
        actionType: 'email_change_current',
        actionUrl: buildActionUrl(redirectUrl, emailData.token_hash_new, 'email_change'),
      })
    }
  } else {
    if (!emailData.token_hash) {
      return NextResponse.json({ error: 'Missing token_hash' }, { status: 400 })
    }
    mails.push({
      to: recipient,
      actionType,
      actionUrl: buildActionUrl(redirectUrl, emailData.token_hash, actionType),
    })
  }

  const emailService = getEmailService()
  for (const mail of mails) {
    const built = buildAuthEmail({
      actionType: mail.actionType,
      appName,
      actionUrl: mail.actionUrl,
      otpCode: mail.otpCode,
    })
    const result = await emailService.sendEmail({
      to: mail.to,
      subject: built.subject,
      html: built.html,
      text: built.text,
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
    })
    if (!result.success) {
      // Non-2xx makes Supabase retry, which is the recovery we want: auth
      // mail must not be silently dropped.
      log.error('auth mail send failed', new Error(result.error ?? 'unknown'), {
        actionType: mail.actionType,
      })
      return NextResponse.json({ error: 'Send failed' }, { status: 500 })
    }
  }

  return NextResponse.json({})
}
