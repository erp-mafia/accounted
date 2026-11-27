/**
 * A storno of a customer invoice's verifikat (source_type invoice_created),
 * refused once the invoice is sent or paid.
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) runs the check through the
 * reversal hook list (lib/composition/reversal-hooks.ts) before anything is
 * written. A sent or paid invoice is withdrawn with Kreditera: the credit note
 * reverses the sale and the invoice follows it. A storno of the verifikat
 * alone would leave the invoice sent or paid in the kundreskontra against a
 * sale the ledger no longer holds.
 *
 * The invoice is the one whose journal_entry_id names the verifikat, never
 * the one its source_id names: a verifikat that was posted and never linked
 * (Bokför losing its link race) books no invoice and reverses freely.
 *
 * Kept free of engine imports so the engine can reach it through the
 * composition seam without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { IssuedInvoiceStornoError } from '@/lib/bookkeeping/errors'
import { OWED_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'

/** Sent (overdue and part-paid included, the statuses still owed) or paid. */
const SENT_OR_PAID_STATUSES: readonly string[] = [...OWED_INVOICE_STATUSES, 'paid']

/** Throws IssuedInvoiceStornoError when the invoice the verifikat books is sent or paid. */
export async function assertInvoiceVerifikatReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  if (error) throw new Error(`customer invoice verifikat: lookup by voucher failed: ${error.message}`)
  const issued = ((data ?? []) as Array<{ id: string; status: string }>).find((invoice) =>
    SENT_OR_PAID_STATUSES.includes(invoice.status),
  )
  if (issued) throw new IssuedInvoiceStornoError(issued.id)
}
