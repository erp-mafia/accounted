/**
 * The receipt follows its invoice: when the invoice of a pair (an invoice
 * and the receipt it came with as one purchase, lib/inkorg/pairs.ts) has
 * been booked, the receipt ends up as an underlag of that same booking, so
 * the purchase is booked once and the receipt never asks to be booked again.
 *
 * Nothing is booked here and no verifikat changes. Where the invoice's
 * booking landed decides where the receipt goes, through the doors that
 * already link underlag to a booked purchase:
 *   - the invoice was paired with a bank row that is now booked (matched
 *     and booked, or booked from the document with the row): the receipt is
 *     matched to the same row, which completes it on the row's verifikat
 *     (lib/documents/inbox-match.ts);
 *   - the invoice became a supplier invoice settled by exactly one bank row
 *     (Registrera och koppla till betalningen): the same, on the payment's
 *     verifikat, where the payment it proves is booked;
 *   - the invoice was booked on a verifikat of its own with no bank row (an
 *     utlägg, the owner's own money): the receipt's document is linked to
 *     that verifikat and the receipt stamped with it
 *     (lib/transactions/inbox-underlag.ts completeInboxItemOnEntry).
 * Anything else waits, and the receipt stays in the inbox for a person:
 * the invoice not booked yet, registered but unpaid (the payment the receipt
 * proves is not in the books), or settled by several rows.
 *
 * The pair is read again here, never taken from the caller: the receipt
 * must still be open and the two must still be one purchase by the same rule
 * the list applies, with the invoice read as it stood before its booking.
 */
import { pairInboxItems } from '@/lib/inkorg/pairs'
import { readDeliverySiblings, type PairableRow } from '@/lib/inkorg/pairs-read'
import { matchInboxItemTransaction } from '@/lib/documents/inbox-match'
import { completeInboxItemOnEntry, resolveBookedJournalEntryIds } from '@/lib/transactions/inbox-underlag'
import type { OperationContext, OperationOutcome } from './types'

export type CompanionResult =
  | {
      status: 'completed'
      /** The verifikat the receipt is now an underlag of. */
      journal_entry_id: string
      /** The bank row both are paired with, when the booking has one. */
      transaction_id: string | null
    }
  | {
      /** Nothing written: the receipt stays in the inbox. */
      status: 'waiting'
      reason: 'invoice_not_booked' | 'invoice_unpaid' | 'several_payments' | 'receipt_not_linked'
    }
  | {
      /** The receipt was already handled: nothing to do. */
      status: 'already_done'
    }

async function readItem(ctx: OperationContext, id: string): Promise<PairableRow | null> {
  const { data, error } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id')
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as PairableRow | null) ?? null
}

/** The one bank row a supplier invoice's payments were made from, or why there is none. */
async function settlingRow(
  ctx: OperationContext,
  supplierInvoiceId: string,
): Promise<{ transactionId: string } | { reason: 'invoice_unpaid' | 'several_payments' }> {
  const { data, error } = await ctx.supabase
    .from('supplier_invoice_payments')
    .select('transaction_id')
    .eq('company_id', ctx.companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
  if (error) throw error
  const rows = [...new Set(((data ?? []) as Array<{ transaction_id: string | null }>).map((p) => p.transaction_id).filter((t): t is string => !!t))]
  if (rows.length === 0) return { reason: 'invoice_unpaid' }
  if (rows.length > 1) return { reason: 'several_payments' }
  return { transactionId: rows[0] }
}

/** The receipt follows the invoice onto its bank row: matched to it, completed on its verifikat. */
async function followOntoRow(
  ctx: OperationContext,
  receipt: PairableRow,
  transactionId: string,
): Promise<OperationOutcome<CompanionResult>> {
  const journalEntryId = (await resolveBookedJournalEntryIds(ctx.supabase, ctx.companyId, [transactionId])).get(transactionId) ?? null
  if (!journalEntryId) return { ok: true, data: { status: 'waiting', reason: 'invoice_not_booked' } }
  const matched = await matchInboxItemTransaction(ctx, receipt.id, transactionId)
  if (!matched.ok) return matched
  // The match completes the receipt on the row's verifikat, best effort: say so only when it did.
  const after = await readItem(ctx, receipt.id)
  if (after?.created_journal_entry_id !== journalEntryId) {
    return { ok: true, data: { status: 'waiting', reason: 'receipt_not_linked' } }
  }
  return { ok: true, data: { status: 'completed', journal_entry_id: journalEntryId, transaction_id: transactionId } }
}

/**
 * Bring the receipt `receiptItemId` onto the booking of the invoice
 * `invoiceItemId` it came with, when that booking exists.
 */
export async function followInvoiceWithReceipt(
  ctx: OperationContext,
  invoiceItemId: string,
  receiptItemId: string,
): Promise<OperationOutcome<CompanionResult>> {
  try {
    const [invoice, receipt] = await Promise.all([readItem(ctx, invoiceItemId), readItem(ctx, receiptItemId)])
    if (!invoice || !receipt) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
    if (receipt.created_journal_entry_id || receipt.created_supplier_invoice_id || receipt.routed_to_arkiv_at) {
      return { ok: true, data: { status: 'already_done' } }
    }

    // Still one purchase by the list's rule, the invoice read as it stood before its booking.
    const { items, arrivalIds } = await readDeliverySiblings(ctx.supabase, ctx.companyId, invoice)
    const withReceipt = items.some((item) => item.id === receipt.id) ? items : [...items, receipt]
    const pairing = pairInboxItems(withReceipt, { arrivalIds, assumeOpen: new Set([invoice.id]) }).get(receipt.id)
    if (pairing?.role !== 'receipt' || pairing.invoice_item_id !== invoice.id) {
      return { ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' }
    }

    if (invoice.matched_transaction_id) return await followOntoRow(ctx, receipt, invoice.matched_transaction_id)

    if (invoice.created_supplier_invoice_id) {
      const row = await settlingRow(ctx, invoice.created_supplier_invoice_id)
      if ('reason' in row) return { ok: true, data: { status: 'waiting', reason: row.reason } }
      return await followOntoRow(ctx, receipt, row.transactionId)
    }

    if (invoice.created_journal_entry_id) {
      const journalEntryId = invoice.created_journal_entry_id
      const outcome = await completeInboxItemOnEntry(ctx.supabase, ctx.companyId, receipt, journalEntryId, {
        // A person booked the purchase with the receipt shown as part of it; the pairing rule is the evidence.
        basis: 'user_confirmed',
        evidence: { rule_id: `inbox_receipt_pair:${pairing.basis}` },
      })
      if (outcome !== 'completed') return { ok: true, data: { status: 'waiting', reason: 'receipt_not_linked' } }
      return { ok: true, data: { status: 'completed', journal_entry_id: journalEntryId, transaction_id: null } }
    }

    return { ok: true, data: { status: 'waiting', reason: 'invoice_not_booked' } }
  } catch (error) {
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
}
