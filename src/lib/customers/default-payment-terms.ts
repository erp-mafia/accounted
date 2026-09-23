import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolve the payment terms for a new customer.
 *
 * Order: the caller-provided value, then the company's own default
 * (company_settings.invoice_default_days, the same setting the invoice
 * flow reads), then 30 as the last resort. Best-effort on the settings
 * read: a missing row or query error falls back to 30 rather than
 * failing the create.
 */
export async function resolveDefaultPaymentTerms(
  supabase: SupabaseClient,
  companyId: string,
  provided: number | null | undefined,
): Promise<number> {
  if (typeof provided === 'number' && Number.isFinite(provided) && provided > 0) {
    return provided
  }

  const { data } = await supabase
    .from('company_settings')
    .select('invoice_default_days')
    .eq('company_id', companyId)
    .maybeSingle()

  const days = (data as { invoice_default_days?: number | null } | null)?.invoice_default_days
  return typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : 30
}
