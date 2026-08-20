import type { SupabaseClient } from '@supabase/supabase-js'

export const FALLBACK_CUSTOMER_PAYMENT_TERMS = 30

/**
 * Resolve payment terms for a newly created customer.
 *
 * A value supplied by the caller always wins. Otherwise the invoice default
 * for the company is used, with 30 days reserved for companies that do not
 * yet have a settings row.
 */
export async function resolveDefaultCustomerPaymentTerms(
  supabase: Pick<SupabaseClient, 'from'>,
  companyId: string,
  requestedDays?: number,
): Promise<number> {
  if (requestedDays !== undefined) return requestedDays

  const { data, error } = await supabase
    .from('company_settings')
    .select('invoice_default_days')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw error
  return data?.invoice_default_days ?? FALLBACK_CUSTOMER_PAYMENT_TERMS
}
