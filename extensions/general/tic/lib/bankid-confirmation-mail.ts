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
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { buildAuthEmail } from '@/lib/email/auth-templates'
import { getSenderForBrand } from '@/lib/email/brand-sender'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { createLogger } from '@/lib/logger'

const log = createLogger('tic/bankid-confirmation-mail')

export interface SendBankIdConfirmationInput {
  /** Service-role client (auth.admin.generateLink). */
  supabase: SupabaseClient
  /** Normalised (trimmed, lower-cased) recipient address. */
  email: string
  /** Forwarded host of the request, '' when unknown. */
  host: string
  /** Forwarded protocol of the request; defaults to https. */
  proto?: string | null
}

export type SendBankIdConfirmationResult =
  | { ok: true }
  | { ok: false; step: 'generate_link' | 'send'; message?: string }

/**
 * Confirmation links must land on the ORIGINATING host (the brand mail
 * resolves its brand from it), mirroring POST /api/auth/signup. With no host
 * (direct invocation, tests) the canonical app URL is used.
 */
export function buildConfirmationUrl(
  host: string,
  proto: string | null | undefined,
  tokenHash: string,
): string {
  const base = host ? `${proto || 'https'}://${host}` : getBranding().appUrl
  const url = new URL('/auth/callback', base)
  url.searchParams.set('token_hash', tokenHash)
  url.searchParams.set('type', 'magiclink')
  return url.toString()
}

export async function sendBankIdSignupConfirmation(
  input: SendBankIdConfirmationInput,
): Promise<SendBankIdConfirmationResult> {
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

  const brand = input.host ? await resolveBrandByHost(input.host) : null
  const sender = getSenderForBrand(brand)
  const appName = brand?.appName ?? getBranding().appName

  const mail = buildAuthEmail({
    actionType: 'bankid_signup',
    appName,
    actionUrl: buildConfirmationUrl(input.host, input.proto, link.properties.hashed_token),
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
