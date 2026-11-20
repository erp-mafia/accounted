import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { isBalanceSheetAccount } from '@/lib/invoices/posting-account'

/** A year's posted IB verifikat that the period does not point at. */
export interface UnlinkedOpeningBalance {
  entryId: string
  lines: Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
    dimensions: Record<string, unknown> | null
  }>
}

/**
 * The IB verifikat of the year starting on `periodStart` when the period has
 * no opening_balance_entry_id: posted, source_type 'opening_balance' and dated
 * on the year's first day, the definition the derived IB uses
 * (20261025120000). Such a verifikat exists where the IB was posted without
 * the link being written: an IB booked through create_voucher before that door
 * linked it, a verifikat marked as IB in bank reconciliation, an imported
 * voucher recognised as the year's IB, or a link that failed after posting.
 *
 * Null unless the reading is unambiguous: exactly one such verifikat, with
 * balance-sheet lines only (class 1-2). With several, or with a result line
 * that leaving the verifikat out of the period would drop from the
 * resultaträkning, the year reads as before.
 */
export async function findUnlinkedOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
): Promise<UnlinkedOpeningBalance | null> {
  const lines = await fetchEntryLines<UnlinkedOpeningBalance['lines'][number] & { journal_entry_id: string }>({
    supabase,
    lineColumns: 'id, journal_entry_id, account_number, debit_amount, credit_amount, dimensions',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('source_type', 'opening_balance')
        .eq('status', 'posted')
        .eq('entry_date', periodStart),
    attachEntriesAs: null,
  })
  if (lines.length === 0) return null

  const entryId = lines[0].journal_entry_id
  if (lines.some((line) => line.journal_entry_id !== entryId)) return null
  if (lines.some((line) => !isBalanceSheetAccount(line.account_number))) return null
  return { entryId, lines }
}
