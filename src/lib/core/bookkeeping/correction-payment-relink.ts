/**
 * The payment rows of a corrected verifikat follow the correction.
 *
 * A payment verifikat (invoice_paid, invoice_cash_payment and the supplier
 * pair) has a mirror outside the ledger: the invoice_payments or
 * supplier_invoice_payments row that says which invoice it paid, and for a
 * supplier invoice the payment_journal_entry_id pointer. correctEntry already
 * moves the bank rows and the underlag to the corrected verifikat; the
 * payment rows stayed on the reversed original. The invoice then read as
 * paid by a verifikat that no longer stands, the corrected verifikat as
 * paying nothing, and linking the invoice to it was refused as a second
 * payment of what was left (PH 227: 42 of 52 corrected payment verifikat in
 * production kept their rows on the reversed original).
 *
 * The rows are re-pointed, not deleted: a correction rebooks the same
 * affärshändelse, so the payment stands and the invoice keeps its status.
 * The amount on the row is the payment's, in the invoice's currency, and is
 * left as it is.
 *
 * Only the payment source types carry these rows from a booking door, and
 * a correction of one is itself corrected under source_type 'correction', so
 * both are relinked; every other source type is skipped without a query.
 *
 * Best-effort, as the other relinks in correctEntry: a failure is logged and
 * returned, never thrown, because the correction is already posted and the
 * correction_of_id chain keeps it traceable. A payment row with a bank row is
 * held to the same anchor rule as the bank row (guard_cash_transaction_anchor):
 * when the correction takes the bank leg out, the row stays where it was.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'
import type { JournalEntry } from '@/types'

export function correctionCarriesPaymentRows(sourceType: string | null | undefined): boolean {
  return sourceType === 'correction' || isPaymentSourceType(sourceType)
}

export async function relinkPaymentRowsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  original: Pick<JournalEntry, 'id' | 'source_type'>,
  toEntryId: string,
): Promise<string | undefined> {
  if (!correctionCarriesPaymentRows(original.source_type)) return undefined

  const moves = [
    { table: 'invoice_payments', column: 'journal_entry_id' },
    { table: 'supplier_invoice_payments', column: 'journal_entry_id' },
    { table: 'supplier_invoices', column: 'payment_journal_entry_id' },
  ] as const

  let firstError: string | undefined
  for (const { table, column } of moves) {
    const { error } = await supabase
      .from(table)
      .update({ [column]: toEntryId })
      .eq('company_id', companyId)
      .eq(column, original.id)
    if (error) {
      console.error(
        `[storno] relinkPaymentRowsToEntry: failed to move ${table}.${column} ${original.id} → ${toEntryId}:`,
        error.message,
      )
      firstError ??= error.message
    }
  }
  return firstError
}
