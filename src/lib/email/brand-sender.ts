/**
 * Brand-aware outbound mail identity (WL-13).
 *
 * THE RULE: every outbound mail is sent in the brand of the COMPANY it
 * concerns, resolved via resolveBrandForCompany (WL-12). These helpers are
 * the ONLY entry points call sites use for sender identity and link base
 * URLs; a company without a brand gets exactly today's values, byte for byte.
 *
 * Sender chain (WL-04):
 *   1. Brand with a VERIFIED Resend sender domain and an authEmailFrom
 *      address: send from the brand address with the brand app name.
 *   2. Brand without a verified sender domain: ride the platform default
 *      address with the brand name alone as the display name (fromName set,
 *      no fromAddress; no "via <platform>", founder call 2026-08-05).
 *      DMARC-clean: the From domain stays ours.
 *   3. No brand: platform defaults (fromName/fromAddress/replyTo all null,
 *      the email service renders "<Platform> <RESEND_FROM_EMAIL>").
 */

import { getBranding } from '@/lib/branding/service'
import { resolveBrandForCompany, type Brand } from '@/lib/branding/resolve'

export interface BrandSender {
  /** Display name for the From header; null = platform default. */
  fromName: string | null
  /**
   * Explicit From address; only set when the brand's sender domain is
   * verified in Resend. Null = platform default address.
   */
  fromAddress: string | null
  /** Reply-To; the brand's support address when a brand exists, else null. */
  replyTo: string | null
  /** The resolved brand, for callers that also need appName/domain/logo. */
  brand: Brand | null
}

/** Pure mapping from a resolved brand to sender identity. */
export function getSenderForBrand(brand: Brand | null): BrandSender {
  if (!brand) {
    return { fromName: null, fromAddress: null, replyTo: null, brand: null }
  }
  if (brand.senderDomainStatus === 'verified' && brand.authEmailFrom) {
    return {
      fromName: brand.appName,
      fromAddress: brand.authEmailFrom,
      replyTo: brand.supportEmail || null,
      brand,
    }
  }
  // Unverified/pending/failed sender domain: "via Accounted" fallback.
  return {
    fromName: brand.appName,
    fromAddress: null,
    replyTo: brand.supportEmail || null,
    brand,
  }
}

/**
 * Sender identity for mail concerning `companyId`. Host-independent and
 * cron-safe: resolution goes company -> team -> brand.
 */
export async function getSenderForCompany(companyId: string): Promise<BrandSender> {
  return getSenderForBrand(await resolveBrandForCompany(companyId))
}

/** Base URL mailed links should point at, given an already-resolved brand. */
export function getBaseUrlForBrand(brand: Brand | null): string {
  return brand ? `https://${brand.domain}` : getBranding().appUrl
}

/**
 * Base URL for links in mail concerning `companyId`: the brand's home domain
 * when the company's team has a brand, else the canonical app URL
 * (NEXT_PUBLIC_APP_URL via getBranding().appUrl).
 */
export async function getBaseUrlForCompany(companyId: string): Promise<string> {
  return getBaseUrlForBrand(await resolveBrandForCompany(companyId))
}
