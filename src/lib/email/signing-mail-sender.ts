/**
 * Who the signing mails (the request, its reminder and the signed copy) say
 * they are from, and the logo they carry.
 *
 * A company without a white-label brand sends as "<company> via <platform>"
 * on the platform's default address: the recipient sees whose document it
 * is, the From domain stays ours (DMARC-clean), the way Scrive and DocuSign
 * send. A company with a brand keeps the WL-13 identity of
 * ./brand-sender.ts unchanged (founder call: no "via" for brands). Only the
 * signing mails use this; every other mail keeps getSenderForCompany as is.
 */
import { getBranding } from '@/lib/branding/service'
import { getSenderForCompany, type BrandSender } from '@/lib/email/brand-sender'
import { signingSenderBrand } from '@/lib/signing/brand'
import { mailLogo, resolveSigningLogo, type MailLogo } from '@/lib/signing/logo'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

const log = createLogger('email.signing-sender')
const warn = (what: string, companyId: string) => (err: unknown) => {
  log.warn(`signing mail ${what} unavailable, sending without it`, { companyId, error: err instanceof Error ? err.message : String(err) })
  return null
}

export interface SigningMailIdentity {
  fromName: string | null
  fromAddress: string | null
  replyTo: string | null
  /** The platform the mail went out through, for the footer. */
  platformName: string
  /** The company logo, or null to draw its initials. */
  logo: MailLogo | null
}

/** The From identity: the brand's own (WL-13) when there is one, else "<company> via <platform>" on our address. */
export function signingFromIdentity(sender: BrandSender, companyName: string, platformName: string): Pick<SigningMailIdentity, 'fromName' | 'fromAddress' | 'replyTo'> {
  if (sender.brand) return { fromName: sender.fromName, fromAddress: sender.fromAddress, replyTo: sender.replyTo }
  const company = companyName.trim()
  return { fromName: company ? `${company} via ${platformName}` : platformName, fromAddress: null, replyTo: null }
}

/**
 * The identity for a signing mail about `companyId`. The logo is a nicety:
 * when it cannot be read the mail draws the initials, and it never stops
 * the mail.
 */
export async function resolveSigningMailIdentity(companyId: string, companyName: string): Promise<SigningMailIdentity> {
  const [sender, brand] = await Promise.all([
    getSenderForCompany(companyId),
    (async () => signingSenderBrand(createServiceClient(), companyId))().catch(warn('brand', companyId)),
  ])
  const platformName = brand?.platformName ?? sender.brand?.appName ?? getBranding().appName
  const logoUrl = brand?.logoUrl ?? null
  const logo = mailLogo(logoUrl, await resolveSigningLogo(logoUrl).catch(warn('logo', companyId)))
  return { ...signingFromIdentity(sender, companyName, platformName), platformName, logo }
}
