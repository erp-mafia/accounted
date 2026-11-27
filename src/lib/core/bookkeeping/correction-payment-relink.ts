/**
 * The payment rows of a corrected verifikat follow the correction, and so
 * does the pointer of the invoice the verifikat books.
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
 *
 * The invoice's own verifikat pointer follows the correction too
 * (relinkRegistrationPointersToEntry). invoices.journal_entry_id and
 * supplier_invoices.registration_journal_entry_id name the verifikat that
 * books the invoice or the credit note: the receivable or the skuld.
 * correctEntry reverses that verifikat and posts the corrected one in its
 * place. Left behind, the invoice names the reversed original, and the
 * corrected verifikat that now carries the receivable or the skuld has no
 * invoice: what reads the pointer from either side (the underlag references
 * and counts of a verifikat among others) gets the wrong verifikat.
 *
 * That move skips no source type. The pointer equals the original's id
 * exactly when the original is the invoice's verifikat, which its source type
 * does not say: beside the registration doors (invoice_created, credit_note,
 * supplier_invoice_registered, supplier_credit_note) an invoice is linked to
 * a verifikat that was already in the books, the imported voucher of a
 * migrated invoice (link-migrated-registration-vouchers.ts) or any posted
 * voucher that booked it (register-booked.ts, register-booked-invoice.ts),
 * and a corrected registration is itself corrected under 'correction'. A
 * filter would save two indexed updates that match no row, and would leave
 * those pointers on the reversed original.
 *
 * One trigger guards the two columns: guard_kontantmetod_carry_link holds the
 * pointer of a posted kontantmetod year-end carry. It does not meet this move,
 * since correctEntry refuses to correct a carry and the original is
 * 'reversed' before its pointers are moved. A refusal, from it or from
 * anything else, leaves the row where it is and is returned like the others.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPaymentSourceType } from '@/lib/bookkeeping/payment-sync'
import type { JournalEntry } from '@/types'

type EntryPointer = { readonly table: string; readonly column: string }

const PAYMENT_ROW_POINTERS: readonly EntryPointer[] = [
  { table: 'invoice_payments', column: 'journal_entry_id' },
  { table: 'supplier_invoice_payments', column: 'journal_entry_id' },
  { table: 'supplier_invoices', column: 'payment_journal_entry_id' },
]

const REGISTRATION_POINTERS: readonly EntryPointer[] = [
  { table: 'invoices', column: 'journal_entry_id' },
  { table: 'supplier_invoices', column: 'registration_journal_entry_id' },
]

export function correctionCarriesPaymentRows(sourceType: string | null | undefined): boolean {
  return sourceType === 'correction' || isPaymentSourceType(sourceType)
}

/** Each pointer in turn, company-scoped; the first failure is returned, every failure logged. */
async function moveEntryPointers(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string,
  pointers: readonly EntryPointer[],
  caller: string,
): Promise<string | undefined> {
  let firstError: string | undefined
  for (const { table, column } of pointers) {
    const { error } = await supabase
      .from(table)
      .update({ [column]: toEntryId })
      .eq('company_id', companyId)
      .eq(column, fromEntryId)
    if (error) {
      console.error(
        `[storno] ${caller}: failed to move ${table}.${column} ${fromEntryId} → ${toEntryId}:`,
        error.message,
      )
      firstError ??= error.message
    }
  }
  return firstError
}

export async function relinkPaymentRowsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  original: Pick<JournalEntry, 'id' | 'source_type'>,
  toEntryId: string,
): Promise<string | undefined> {
  if (!correctionCarriesPaymentRows(original.source_type)) return undefined
  return moveEntryPointers(supabase, companyId, original.id, toEntryId, PAYMENT_ROW_POINTERS, 'relinkPaymentRowsToEntry')
}

export async function relinkRegistrationPointersToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string,
): Promise<string | undefined> {
  return moveEntryPointers(supabase, companyId, fromEntryId, toEntryId, REGISTRATION_POINTERS, 'relinkRegistrationPointersToEntry')
}
