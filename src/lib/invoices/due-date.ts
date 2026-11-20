import type { SupabaseClient } from '@supabase/supabase-js'

function isWholeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * The payment terms of a customer invoice: the customer's, then the company
 * default, then 30. 0 on the card is betalning direkt (#2070), a choice, not
 * "unset". The company setting takes no 0: its form stores 30 for one.
 */
export function invoiceTermsFor(customerTerms: unknown, companyDefault: unknown): number {
  if (isWholeDays(customerTerms)) return customerTerms
  return isWholeDays(companyDefault) && companyDefault > 0 ? companyDefault : 30
}

/**
 * invoiceTermsFor at a door that has no settings row at hand: the company
 * default is read only when the card has no terms. A failed read throws: a
 * silent 30 would date the receivable wrong. A missing row is an answer.
 */
export async function loadInvoiceTerms(
  supabase: SupabaseClient,
  companyId: string,
  customerTerms: number | null | undefined,
): Promise<number> {
  if (isWholeDays(customerTerms)) return customerTerms
  const { data, error } = await supabase
    .from('company_settings')
    .select('invoice_default_days')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return invoiceTermsFor(customerTerms, (data as { invoice_default_days?: number | null } | null)?.invoice_default_days)
}
