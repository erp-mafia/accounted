/**
 * The bank rows a räkenskapsår books twice.
 *
 * A bank row is booked twice when two or more verifikat booked from it stand
 * in the year and are copies of each other (the same accounts with the same
 * debit and credit amounts): the bank account then carries the row's amount
 * more than once, and the books no longer match the bank. The rule, its
 * exclusions (a verifikat a posted storno reverses, one another bank row is
 * booked on) and which copy stays are public.bank_rows_booked_twice
 * (20261127190000); this reads it for the readiness report.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export interface BookedVoucher {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
}

export interface BankRowBookedTwice {
  transaction_id: string
  /** The verifikat that stays: the one the bank row names, else the first posted. */
  kept: BookedVoucher
  /** The other copies, in voucher order: each one is to be reversed. */
  extras: BookedVoucher[]
}

interface BookedTwiceRow {
  transaction_id: string
  kept_journal_entry_id: string
  kept_voucher_series: string | null
  kept_voucher_number: number | null
  extra_entries: BookedVoucher[] | null
}

export async function bankRowsBookedTwice(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<BankRowBookedTwice[]> {
  const rows = await fetchAllRows<BookedTwiceRow>(({ from, to }) =>
    supabase
      .rpc('bank_rows_booked_twice', { p_company_id: companyId, p_fiscal_period_id: fiscalPeriodId })
      .order('transaction_id', { ascending: true })
      .range(from, to),
  )
  return rows.map((row) => ({
    transaction_id: row.transaction_id,
    kept: {
      journal_entry_id: row.kept_journal_entry_id,
      voucher_series: row.kept_voucher_series,
      voucher_number: row.kept_voucher_number,
    },
    extras: row.extra_entries ?? [],
  }))
}
