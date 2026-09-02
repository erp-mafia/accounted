/**
 * Verifikationsserie per bankkonto.
 *
 * Resolution order for an entry booked from a bank transaction:
 *   1. explicit voucher_series in the request (the booking dialog's picker)
 *   2. cash_accounts.voucher_series of the transaction's account (this module)
 *   3. company_settings.default_voucher_series_per_source_type (engine)
 *   4. 'A' (engine)
 *
 * This helper covers step 2 only. It returns undefined whenever there is no
 * override so callers can pass the result straight into CreateJournalEntryInput
 * and let the engine handle steps 3 and 4. Lookup failures also resolve to
 * undefined: a broken override must never block a booking, the entry then
 * lands in the per-type default exactly as before this feature.
 *
 * Scope: bank-transaction bookings (book route, categorize, agent, pending
 * operations). Invoice settlements matched from the bank keep the invoice
 * payment series (invoice_paid, supplier_invoice_paid): those series describe
 * the payment kind, not the account the money moved through.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const SERIES_LETTER_RE = /^[A-Z]$/

/** Pure: the override letter of a cash account row, or undefined. */
export function cashAccountSeriesOverride(
  account: { voucher_series?: string | null } | null | undefined,
): string | undefined {
  const value = account?.voucher_series
  return typeof value === 'string' && SERIES_LETTER_RE.test(value) ? value : undefined
}

/**
 * Look up the series override of one of the company's cash accounts.
 * undefined when the account is unknown, has no override, or the query fails.
 */
export async function resolveCashAccountVoucherSeries(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null | undefined,
): Promise<string | undefined> {
  if (!cashAccountId) return undefined
  try {
    const { data, error } = await supabase
      .from('cash_accounts')
      .select('voucher_series')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()
    if (error) return undefined
    return cashAccountSeriesOverride(data as { voucher_series?: string | null } | null)
  } catch {
    return undefined
  }
}
