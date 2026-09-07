import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createLogger } from '@/lib/logger'
import { getEmailService } from '@/lib/email/service'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { getSenderForBrand } from '@/lib/email/brand-sender'
import { buildAuthEmail } from '@/lib/email/auth-templates'
import { verifyStandardWebhookSignature } from '@/lib/email/standard-webhook'
import {
  BrandLookupFailedError,
  resolveTrustedAppOrigin,
} from '@/lib/domains/trusted-app-origin'

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
 * parsing. The signature proves WHO sent the payload, not that every
 * destination in it should be followed: redirect_to is GoTrue's already
 * allowlisted referrer, but that allowlist is a glob configured by hand, so
 * the origin is resolved here again through lib/domains/trusted-app-origin
 * (canonical, this deployment's own Vercel hosts, or a registered brand
 * domain). Anything else gets a canonical link, and the token never rides
 * to a host this deployment does not serve. This endpoint is
 * availability-critical once the hook is enabled:
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
 *
 * `origin` is the already-trusted application origin; `redirectUrl` is the
 * requested redirect_to only when it sits on that origin, else null (the
 * link then lands on the origin's /auth/callback with no `next`).
 */
function buildActionUrl(
  origin: string,
  redirectUrl: URL | null,
  tokenHash: string,
  actionType: string,
): string {
  const verifyType = VERIFY_TYPES.has(actionType) ? actionType : 'email'
  let url: URL
  if (redirectUrl && redirectUrl.pathname === '/auth/callback') {
    url = new URL(redirectUrl.toString())
  } else {
    url = new URL('/auth/callback', origin)
    if (redirectUrl) {
      const next = redirectUrl.pathname + redirectUrl.search
      if (next && next !== '/') url.searchParams.set('next', next)
    }
  }
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', verifyType)
  return url.toString()
}

/**
 * The requested redirect_to, kept only when its origin is one this
 * deployment serves. The comparison is on the resolved origin, so an http
 * link to a hosted domain, a lookalike host, a non-default port or a
 * credential-bearing URL all collapse to the canonical /auth/callback.
 * Throws BrandLookupFailedError when the brands table cannot be read.
 */
async function resolveRedirect(
  requested: string | undefined,
): Promise<{ origin: string; redirectUrl: URL | null }> {
  let requestedUrl: URL | null = null
  if (requested) {
    try {
      requestedUrl = new URL(requested)
    } catch {
      requestedUrl = null
    }
  }
  const origin = await resolveTrustedAppOrigin(requestedUrl?.origin ?? null)
  if (requestedUrl && requestedUrl.origin === origin) {
    return { origin, redirectUrl: requestedUrl }
  }
  if (requestedUrl) {
    // Hostname only: the URL may carry a query, never log the token side.
    log.warn('redirect_to origin is not a served host; linking to the canonical origin', {
      host: requestedUrl.hostname,
    })
  }
  return { origin, redirectUrl: null }
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

  // Brand from the RESOLVED host: redirect_to carries the tenant origin, and
  // the sender identity must match the host the link lands on. A lookup
  // failure is a 500 so Supabase retries rather than sending a mail whose
  // link would land on the wrong domain.
  let resolved: Awaited<ReturnType<typeof resolveRedirect>>
  try {
    resolved = await resolveRedirect(emailData.redirect_to)
  } catch (err) {
    if (!(err instanceof BrandLookupFailedError)) throw err
    log.error('brand lookup failed while resolving redirect_to', err, { host: err.host })
    return NextResponse.json({ error: 'Origin lookup failed' }, { status: 500 })
  }
  const { origin, redirectUrl } = resolved
  const brand = await resolveBrandByHost(new URL(origin).hostname)
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
      actionUrl: buildActionUrl(origin, redirectUrl, emailData.token_hash, 'email_change'),
    })
    if (emailData.token_hash_new) {
      mails.push({
        to: recipient,
        actionType: 'email_change_current',
        actionUrl: buildActionUrl(origin, redirectUrl, emailData.token_hash_new, 'email_change'),
      })
    }
  } else {
    if (!emailData.token_hash) {
      return NextResponse.json({ error: 'Missing token_hash' }, { status: 400 })
    }
    mails.push({
      to: recipient,
      actionType,
      actionUrl: buildActionUrl(origin, redirectUrl, emailData.token_hash, actionType),
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
