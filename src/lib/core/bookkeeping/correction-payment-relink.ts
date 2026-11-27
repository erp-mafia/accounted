/**
 * The payment rows of a corrected verifikat follow the correction, and so
 * do the pointers of the records the verifikat books.
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
 * No source type is skipped. A payment row names the original exactly when
 * the original is its payment verifikat, which its source type does not say:
 * beside the payment doors named above, a privately paid supplier invoice is
 * paid by the verifikat of its utlägg, a payment is linked to a verifikat
 * that was already in the books (imported, or booked by hand), and a
 * corrected payment verifikat is itself corrected under 'correction'. A
 * filter would save three indexed updates that match no row, and would leave
 * those rows on the reversed original.
 *
 * Best-effort, as the other relinks in correctEntry: a failure is logged and
 * returned, never thrown, because the correction is already posted and the
 * correction_of_id chain keeps it traceable. A payment row with a bank row is
 * held to the same anchor rule as the bank row (guard_cash_transaction_anchor):
 * when the correction takes the bank leg out, the row stays where it was.
 *
 * The records the verifikat books follow the correction too
 * (relinkBookedRecordsToEntry). Each names the verifikat that books it in a
 * pointer of its own:
 *   - an invoice or a credit note, invoices.journal_entry_id and
 *     supplier_invoices.registration_journal_entry_id: the verifikat with
 *     the receivable or the skuld;
 *   - the inbox item it was booked from,
 *     invoice_inbox_items.created_journal_entry_id;
 *   - an utlägg, expense_claims.journal_entry_id.
 * correctEntry reverses that verifikat and posts the corrected one in its
 * place. Left behind, the record names the reversed original and the
 * corrected verifikat has no record: what reads the pointer from either side
 * (the underlag references and counts of a verifikat among others) gets the
 * wrong verifikat. Two readers take a reversed verifikat as spent and act on
 * it: an inbox item whose pointer is reversed reads as open and can be booked
 * a second time (bookingStateOfItem), and removing an utlägg whose verifikat
 * is reversed posts no storno (deleteExpenseClaim), which would leave the
 * corrected verifikat in the books with no claim behind it.
 *
 * That move skips no source type either. A pointer equals the original's id
 * exactly when the original is the record's verifikat, which its source type
 * does not say: beside the registration doors (invoice_created, credit_note,
 * supplier_invoice_registered, supplier_credit_note) an invoice is linked to
 * a verifikat that was already in the books, the imported voucher of a
 * migrated invoice (link-migrated-registration-vouchers.ts) or any posted
 * voucher that booked it (register-booked.ts, register-booked-invoice.ts),
 * an inbox item is stamped by whichever door booked it, and a corrected
 * verifikat is itself corrected under 'correction'. A filter would save a
 * few indexed updates that match no row, and would leave those pointers on
 * the reversed original.
 *
 * One trigger guards any of these columns: guard_kontantmetod_carry_link
 * holds the invoice pointer of a posted kontantmetod year-end carry. It does
 * not meet this move, since correctEntry refuses to correct a carry and the
 * original is 'reversed' before its pointers are moved. A refusal, from it or
 * from anything else, leaves the row where it is and is returned like the
 * others. Under row level security a caller who may post the correction may
 * move all four: the invoices and the inbox item take the write role in the
 * active company that the verifikat itself takes, the utlägg any writing
 * member of the company.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type EntryPointer = { readonly table: string; readonly column: string }

const PAYMENT_ROW_POINTERS: readonly EntryPointer[] = [
  { table: 'invoice_payments', column: 'journal_entry_id' },
  { table: 'supplier_invoice_payments', column: 'journal_entry_id' },
  { table: 'supplier_invoices', column: 'payment_journal_entry_id' },
]

/** The records a verifikat books: each names it in a pointer of its own. */
const BOOKED_RECORD_POINTERS: readonly EntryPointer[] = [
  { table: 'invoices', column: 'journal_entry_id' },
  { table: 'supplier_invoices', column: 'registration_journal_entry_id' },
  { table: 'invoice_inbox_items', column: 'created_journal_entry_id' },
  { table: 'expense_claims', column: 'journal_entry_id' },
]

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
  fromEntryId: string,
  toEntryId: string,
): Promise<string | undefined> {
  return moveEntryPointers(supabase, companyId, fromEntryId, toEntryId, PAYMENT_ROW_POINTERS, 'relinkPaymentRowsToEntry')
}

export async function relinkBookedRecordsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string,
): Promise<string | undefined> {
  return moveEntryPointers(supabase, companyId, fromEntryId, toEntryId, BOOKED_RECORD_POINTERS, 'relinkBookedRecordsToEntry')
}
