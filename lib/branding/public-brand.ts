/**
 * Client-safe brand shape + merge logic (WL-12 slice A2).
 *
 * The full `Brand` row carries ops-internal email plumbing (Resend domain id,
 * sender verification state) that has no business in the client bundle. The
 * root layout converts the resolved brand to this serializable subset before
 * handing it to the BrandProvider.
 *
 * `mergeClientBranding` is the single place where per-request brand values
 * are layered over the sync `getBranding()` defaults; it is pure so the
 * fallback behavior is unit-testable without rendering. No brand in, defaults
 * out untouched: that is the additive guarantee for un-branded hosts.
 */

import type { BrandingConfig } from './service'
import type { Brand } from './resolve'

/** Serializable subset of a Brand that may cross to the client. */
export interface PublicBrand {
  appName: string
  logoUrl: string | null
  supportEmail: string
  authEmailFrom: string | null
  brandColor: string
  fontKey: string
  domain: string
}

export function toPublicBrand(brand: Brand): PublicBrand {
  return {
    appName: brand.appName,
    logoUrl: brand.logoUrl,
    supportEmail: brand.supportEmail,
    authEmailFrom: brand.authEmailFrom,
    brandColor: brand.brandColor,
    fontKey: brand.fontKey,
    domain: brand.domain,
  }
}

export interface ClientBranding extends BrandingConfig {
  /** Brand logo URL on a branded host; null on default hosts (use logoPath). */
  logoUrl: string | null
  /** The per-request brand, or null on default hosts. */
  brand: PublicBrand | null
}

/**
 * Layer the per-request brand over the sync branding defaults. With no brand
 * every value is exactly `getBranding()`'s (defaults < env < extension), so
 * un-migrated surfaces and default hosts render exactly as before.
 */
export function mergeClientBranding(
  base: BrandingConfig,
  brand: PublicBrand | null,
): ClientBranding {
  if (!brand) {
    return { ...base, logoUrl: null, brand: null }
  }
  return {
    ...base,
    appName: brand.appName,
    supportEmail: brand.supportEmail,
    authEmailFrom: brand.authEmailFrom ?? base.authEmailFrom,
    themeColor: brand.brandColor,
    logoUrl: brand.logoUrl,
    brand,
  }
}
