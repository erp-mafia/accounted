/**
 * Who a signing request shows as its sender, on the signing page, in the
 * mail and on the Signeringsbevis page: the company's own logo (the one it
 * uploaded for its invoices, company_settings.logo_url) and the platform the
 * request went out through, for "Arcim Technology AB via Accounted". The
 * platform is the company's white-label brand when its team has one
 * (resolveBrandForCompany), else this install's app name.
 *
 * A company without a logo gets null: callers draw its initials instead.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrandForCompany } from '@/lib/branding/resolve'
import { getBranding } from '@/lib/branding/service'

export interface SigningSenderBrand {
  /** The company's own logo (a public storage URL), or null. */
  logoUrl: string | null
  /** The "via" name: the brand's app name, else the platform's. */
  platformName: string
}

export async function signingSenderBrand(service: SupabaseClient, companyId: string): Promise<SigningSenderBrand> {
  const [{ data }, brand] = await Promise.all([
    service.from('company_settings').select('logo_url').eq('company_id', companyId).maybeSingle(),
    resolveBrandForCompany(companyId),
  ])
  const logoUrl = (data as { logo_url?: string | null } | null)?.logo_url?.trim() || null
  return { logoUrl, platformName: brand?.appName ?? getBranding().appName }
}
