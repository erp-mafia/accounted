import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanSupplierPaymentDetails, type SupplierPaymentDetails } from '@/lib/payments/payment-details'

export type SupplierPaymentColumns = Pick<SupplierPaymentDetails, 'bankgiro' | 'plusgiro' | 'iban' | 'bic'>

/**
 * What an inbox item's extraction (the scan, or Peppol's PaymentMeans) says
 * the invoice is paid to. The one reading for every door that registers a
 * supplier invoice from an inbox item: the dashboard and v1 convert, the
 * privately paid create and the MCP approval, so no door can keep less of it
 * than another. Unvalidated: statedPayeeColumns and the backfill validate.
 */
export function inboxStatedPaymentDetails(extractedData: unknown): SupplierPaymentDetails | null {
  const supplier = (extractedData as { supplier?: unknown } | null | undefined)?.supplier
  if (!supplier || typeof supplier !== 'object') return null
  const read = (key: keyof SupplierPaymentDetails): string | null => {
    const value = (supplier as Record<string, unknown>)[key]
    return typeof value === 'string' && value.trim() ? value : null
  }
  const details: SupplierPaymentDetails = {
    bankgiro: read('bankgiro'),
    plusgiro: read('plusgiro'),
    iban: read('iban'),
    bic: read('bic'),
  }
  return Object.values(details).some((value) => value !== null) ? details : null
}

/**
 * Which of the cleaned details the supplier row still lacks. Existing values
 * are never overwritten: a person who typed a bankgiro by hand is right
 * over a scan, and a supplier that changed giro is told through the
 * supplier card, not by the next invoice.
 */
export function planSupplierPaymentBackfill(
  existing: SupplierPaymentColumns,
  details: SupplierPaymentDetails | null | undefined,
): SupplierPaymentColumns {
  const clean = cleanSupplierPaymentDetails(details)
  const plan: SupplierPaymentColumns = {}
  for (const key of ['bankgiro', 'plusgiro', 'iban', 'bic'] as const) {
    if (clean[key] && !(existing[key] ?? '').trim()) plan[key] = clean[key]
  }
  return plan
}

/**
 * Write the details the supplier lacks. Returns the columns written, empty
 * when there was nothing to add. Never throws: a failed backfill must not
 * stop the invoice that carried it.
 */
export async function backfillSupplierPaymentDetails(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
  details: SupplierPaymentDetails | null | undefined,
): Promise<SupplierPaymentColumns> {
  const clean = cleanSupplierPaymentDetails(details)
  if (Object.keys(clean).length === 0) return {}
  const { data: existing, error } = await supabase
    .from('suppliers')
    .select('bankgiro, plusgiro, iban, bic')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !existing) return {}
  const current = existing as SupplierPaymentColumns
  const plan = planSupplierPaymentBackfill(current, clean)
  if (Object.keys(plan).length === 0) return {}
  // Literal keys, so the phantom-column guard can read the payload: every
  // column is written, the untouched ones with the value they already hold.
  const { error: updateError } = await supabase
    .from('suppliers')
    .update({
      bankgiro: plan.bankgiro ?? current.bankgiro ?? null,
      plusgiro: plan.plusgiro ?? current.plusgiro ?? null,
      iban: plan.iban ?? current.iban ?? null,
      bic: plan.bic ?? current.bic ?? null,
    })
    .eq('id', supplierId)
    .eq('company_id', companyId)
  return updateError ? {} : plan
}
