/**
 * The confirmation mail a BankID signup sends to the typed address.
 *
 * The BankID signup used to mint a magic link and hand it straight back to the
 * browser, which proved nothing about the address. Now the link travels only
 * by mail, through the same token_hash + /auth/callback pattern the Supabase
 * Send Email hook uses (app/api/auth/email-hook/route.ts), branded per the
 * requesting host like every other auth mail. The browser never sees the
 * token.
 *
 * `magiclink` rather than `signup` as the link type: GoTrue refuses a signup
 * link for an already-confirmed address, and this mail is also re-sent when a
 * pending identity tries to log in, which includes accounts created by the
 * old flow (confirmed by admin, address never proven). Verifying a magic link
 * confirms an unconfirmed address as a side effect, so both cases converge.
 *
 * This is the one auth mail GoTrue's redirect allowlist never sees: the link
 * is built here and sent through the platform email service, so the host it
 * points at is resolved through lib/domains/trusted-app-origin like every
 * other auth link (canonical, this deployment's own Vercel hosts, or a
 * registered brand domain). The raw Host header is an input, never the
 * destination.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { buildAuthEmail } from '@/lib/email/auth-templates'
import { getSenderForBrand } from '@/lib/email/brand-sender'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import {
  BrandLookupFailedError,
  resolveTrustedAppOrigin,
} from '@/lib/domains/trusted-app-origin'
import { createLogger } from '@/lib/logger'

const log = createLogger('tic/bankid-confirmation-mail')

export interface SendBankIdConfirmationInput {
  /** Service-role client (auth.admin.generateLink). */
  supabase: SupabaseClient
  /** Normalised (trimmed, lower-cased) recipient address. */
  email: string
  /** Forwarded host of the request, '' when unknown. */
  host: string
}

export type SendBankIdConfirmationResult =
  | { ok: true }
  | { ok: false; step: 'resolve_origin' | 'generate_link' | 'send'; message?: string }

/**
 * The verify link on an already-trusted application origin. Callers resolve
 * the origin first (resolveTrustedAppOrigin), so this never sees a raw host.
 */
export function buildConfirmationUrl(origin: string, tokenHash: string): string {
  const url = new URL('/auth/callback', origin)
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', 'magiclink')
  return url.toString()
}

export async function sendBankIdSignupConfirmation(
  input: SendBankIdConfirmationInput,
): Promise<SendBankIdConfirmationResult> {
  // Resolve the destination BEFORE minting a link: a token is only ever
  // generated for a host this deployment is known to serve. An unknown host
  // falls back to the canonical origin; an unreadable brands table refuses
  // (a wrong-brand link whose session lands on a foreign domain is the
  // failure this registry exists to prevent), and the caller rolls the
  // signup back so the person can simply retry.
  let origin: string
  try {
    origin = await resolveTrustedAppOrigin(input.host)
  } catch (err) {
    if (!(err instanceof BrandLookupFailedError)) throw err
    return { ok: false, step: 'resolve_origin', message: err.message }
  }

  const { data: link, error: linkError } = await input.supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: input.email,
  })
  if (linkError || !link?.properties?.hashed_token) {
    log.error('generateLink failed for bankid confirmation mail', {
      code: linkError?.code,
      message: linkError?.message,
    })
    return { ok: false, step: 'generate_link', message: linkError?.message }
  }

  // Brand from the RESOLVED host, so the sender identity always matches the
  // host the link lands on: a rejected host gets canonical mail with a
  // canonical link, never brand mail pointing at the platform domain.
  const brand = await resolveBrandByHost(new URL(origin).hostname)
  const sender = getSenderForBrand(brand)
  const appName = brand?.appName ?? getBranding().appName

  const mail = buildAuthEmail({
    actionType: 'bankid_signup',
    appName,
    actionUrl: buildConfirmationUrl(origin, link.properties.hashed_token),
  })

  const result = await getEmailService().sendEmail({
    to: input.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (!result.success) {
    log.error('bankid confirmation mail send failed', new Error(result.error ?? 'unknown'))
    return { ok: false, step: 'send', message: result.error }
  }
  return { ok: true }
}
