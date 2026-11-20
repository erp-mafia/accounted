import { embeddableLogoUrl } from '@/lib/pdf/logo'

/**
 * The company's invoice branding on a self-billing invoice (crm#1367): the
 * two colours and the logo, the issuer's identity as on its own invoices.
 * The document is set in the built-in Helvetica whatever font the company's
 * own invoices use, so it needs no font registration. A colour that is not a
 * #rrggbb hex falls back to the default ink.
 */
export interface SelfBillingBranding {
  primaryColor: string
  accentColor: string
  /** An embedded PNG data URL (lib/pdf/logo.ts), or null for no logo. */
  logoUrl?: string | null
}

export const DEFAULT_SELF_BILLING_BRANDING: SelfBillingBranding = { primaryColor: '#1a1a1a', accentColor: '#666666' }

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export interface SelfBillingBrandingSettings {
  invoice_primary_color?: string | null
  invoice_accent_color?: string | null
  logo_url?: string | null
  invoice_show_logo?: boolean | null
}

export function selfBillingBranding(settings: SelfBillingBrandingSettings | null | undefined): SelfBillingBranding {
  const pick = (value: string | null | undefined, fallback: string) =>
    typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback
  return {
    primaryColor: pick(settings?.invoice_primary_color, DEFAULT_SELF_BILLING_BRANDING.primaryColor),
    accentColor: pick(settings?.invoice_accent_color, DEFAULT_SELF_BILLING_BRANDING.accentColor),
  }
}

/**
 * The colours plus the logo, resolved the way the company's own invoices
 * resolve it: shown unless the company switched the logo off, and embedded
 * so @react-pdf can draw any uploaded format.
 */
export async function loadSelfBillingBranding(
  settings: SelfBillingBrandingSettings | null | undefined,
): Promise<SelfBillingBranding> {
  const showLogo = settings?.invoice_show_logo ?? true
  return {
    ...selfBillingBranding(settings),
    logoUrl: showLogo ? await embeddableLogoUrl(settings?.logo_url) : null,
  }
}
