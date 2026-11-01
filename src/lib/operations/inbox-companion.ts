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
 *
 * The server runs this itself, so a closed tab or another surface (the
 * Underlag workspace, MCP, v1) cannot leave the receipt behind:
 *   - followPairedReceipt: the doors that book the invoice from the
 *     document (book-direct) call it with the invoice alone, and the pair's
 *     receipt is found here;
 *   - followReceiptsOfSupplierInvoice: a supplier invoice settled against a
 *     bank row (supplier_invoice.match_confirmed, every settling door) brings
 *     the receipt of the inbox item it was registered from onto the payment;
 *   - an invoice matched to a bank row that is booked, by any door, takes
 *     its receipt along in the shared propagation
 *     (lib/transactions/inbox-underlag.ts propagateUnderlagForBookedTransaction).
 * Each is best effort and idempotent: a receipt already handled, or no
 * longer paired, is left alone, and the page's own call
 * (POST /api/inkorg/items/:id/companion) then answers already_done.
 */
import { pairInboxItems, type PairBasis } from '@/lib/inkorg/pairs'
import { readDeliverySiblings, type PairableRow } from '@/lib/inkorg/pairs-read'
import { matchInboxItemTransaction } from '@/lib/documents/inbox-match'
import { completeInboxItemOnEntry, lockedJournalEntryIds, resolveBookedJournalEntryIds } from '@/lib/transactions/inbox-underlag'
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
      /**
       * Nothing written: the receipt stays in the inbox. entry_locked: the
       * verifikat sits in a closed or locked period, where no document can be
       * added (checked before anything is written).
       */
      status: 'waiting'
      reason: 'invoice_not_booked' | 'invoice_unpaid' | 'several_payments' | 'receipt_not_linked' | 'entry_locked'
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

/** A closed or locked period takes no document: refused before anything is written. */
async function entryLocked(ctx: OperationContext, journalEntryId: string): Promise<boolean> {
  return (await lockedJournalEntryIds(ctx.supabase, ctx.companyId, [journalEntryId])).has(journalEntryId)
}

/** The open half follows the booked one onto its bank row: matched to it, completed on its verifikat. */
async function followOntoRow(
  ctx: OperationContext,
  receipt: PairableRow,
  transactionId: string,
): Promise<OperationOutcome<CompanionResult>> {
  const journalEntryId = (await resolveBookedJournalEntryIds(ctx.supabase, ctx.companyId, [transactionId])).get(transactionId) ?? null
  if (!journalEntryId) return { ok: true, data: { status: 'waiting', reason: 'invoice_not_booked' } }
  if (await entryLocked(ctx, journalEntryId)) return { ok: true, data: { status: 'waiting', reason: 'entry_locked' } }
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
 * Where the booked half's booking landed decides where the open half goes
 * (the header's three doors). Usually the invoice was booked and the receipt
 * follows; the other way round too (a receipt booked in the Underlag
 * workspace while its invoice stayed in the inbox).
 */
async function followPair(
  ctx: OperationContext,
  booked: PairableRow,
  open: PairableRow,
  basis: PairBasis,
): Promise<OperationOutcome<CompanionResult>> {
  if (booked.matched_transaction_id) return await followOntoRow(ctx, open, booked.matched_transaction_id)

  if (booked.created_supplier_invoice_id) {
    const row = await settlingRow(ctx, booked.created_supplier_invoice_id)
    if ('reason' in row) return { ok: true, data: { status: 'waiting', reason: row.reason } }
    return await followOntoRow(ctx, open, row.transactionId)
  }

  if (booked.created_journal_entry_id) {
    const journalEntryId = booked.created_journal_entry_id
    if (await entryLocked(ctx, journalEntryId)) return { ok: true, data: { status: 'waiting', reason: 'entry_locked' } }
    const outcome = await completeInboxItemOnEntry(ctx.supabase, ctx.companyId, open, journalEntryId, {
      // A person booked the purchase with the receipt shown as part of it; the pairing rule is the evidence.
      basis: 'user_confirmed',
      evidence: { rule_id: `inbox_receipt_pair:${basis}` },
    })
    if (outcome !== 'completed') return { ok: true, data: { status: 'waiting', reason: 'receipt_not_linked' } }
    return { ok: true, data: { status: 'completed', journal_entry_id: journalEntryId, transaction_id: null } }
  }

  return { ok: true, data: { status: 'waiting', reason: 'invoice_not_booked' } }
}

/** Not handled yet: no verifikat, no supplier invoice, not in Arkiv. */
function stillOpen(item: PairableRow): boolean {
  return !item.created_journal_entry_id && !item.created_supplier_invoice_id && !item.routed_to_arkiv_at
}

/**
 * Bring the receipt `receiptItemId` onto the booking of the invoice
 * `invoiceItemId` it came with, when that booking exists; or, when the
 * receipt is the one booked and the invoice is still open, the invoice onto
 * the receipt's booking. Either way one more underlag on a verifikat that
 * books the purchase, never a booking of its own.
 */
export async function followInvoiceWithReceipt(
  ctx: OperationContext,
  invoiceItemId: string,
  receiptItemId: string,
): Promise<OperationOutcome<CompanionResult>> {
  try {
    const [invoice, receipt] = await Promise.all([readItem(ctx, invoiceItemId), readItem(ctx, receiptItemId)])
    if (!invoice || !receipt) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
    const receiptOpen = stillOpen(receipt)
    if (!receiptOpen && !stillOpen(invoice)) return { ok: true, data: { status: 'already_done' } }
    // The receipt follows the invoice; a receipt booked first takes the open invoice along.
    const [booked, open] = receiptOpen ? [invoice, receipt] : [receipt, invoice]

    // Still one purchase by the list's rule, the booked half read as it stood before its booking.
    const { items, arrivalIds } = await readDeliverySiblings(ctx.supabase, ctx.companyId, invoice)
    const withBoth = [...items, ...[invoice, receipt].filter((one) => !items.some((item) => item.id === one.id))]
    const pairing = pairInboxItems(withBoth, { arrivalIds, assumeOpen: new Set([booked.id]) }).get(receipt.id)
    if (pairing?.role !== 'receipt' || pairing.invoice_item_id !== invoice.id) {
      return { ok: false, code: 'INBOX_COMPANION_NOT_PAIRED' }
    }

    return await followPair(ctx, booked, open, pairing.basis)
  } catch (error) {
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
}

/** What the server-side follow did: the companion answer, or no receipt to follow. */
export type PairedReceiptFollow = CompanionResult | { status: 'no_receipt' } | { status: 'failed'; code: string }

/**
 * The item `invoiceItemId` was just booked: bring the other half of its
 * purchase (when it came with one, still open) onto that booking: the
 * receipt of an invoice, or the invoice of a receipt booked first. The doors
 * that book an item call this themselves, after their own writes. Never
 * throws, never fails the door: the booking stands either way, a failure is
 * logged and answered as such, and a half that waits stays in the inbox for
 * the page or a person.
 */
export async function followPairedReceipt(ctx: OperationContext, invoiceItemId: string): Promise<PairedReceiptFollow> {
  try {
    const booked = await readItem(ctx, invoiceItemId)
    if (!booked) return { status: 'no_receipt' }
    const { items, arrivalIds } = await readDeliverySiblings(ctx.supabase, ctx.companyId, booked)
    if (items.length < 2) return { status: 'no_receipt' }
    const pairing = pairInboxItems(items, { arrivalIds, assumeOpen: new Set([booked.id]) }).get(booked.id)
    if (!pairing) return { status: 'no_receipt' }
    const otherId = pairing.role === 'invoice' ? pairing.receipt_item_id : pairing.invoice_item_id
    const open = items.find((item) => item.id === otherId)
    if (!open) return { status: 'no_receipt' }

    const outcome = await followPair(ctx, booked, open, pairing.basis)
    if (!outcome.ok) {
      ctx.log.warn('inbox companion: the other half did not follow its booking', { invoiceItemId, otherItemId: open.id, code: outcome.code })
      return { status: 'failed', code: outcome.code }
    }
    if (outcome.dryRun) return { status: 'no_receipt' }
    return outcome.data
  } catch (error) {
    ctx.log.warn('inbox companion: the receipt follow could not run', {
      invoiceItemId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: 'failed', code: 'UNKNOWN_ERROR' }
  }
}

/**
 * A supplier invoice was settled against a bank row: the receipt of every
 * inbox item it was registered from follows onto the payment's verifikat
 * (the invoice registered unpaid, its receipt kept as its companion, then
 * paid). Each item's follow never throws (followPairedReceipt); a failed
 * read of the items throws to the caller, the supplier_invoice.match_confirmed
 * consumer, so the event bus logs it as an error.
 */
export async function followReceiptsOfSupplierInvoice(ctx: OperationContext, supplierInvoiceId: string): Promise<PairedReceiptFollow[]> {
  const { data, error } = await ctx.supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', ctx.companyId)
    .eq('created_supplier_invoice_id', supplierInvoiceId)
  if (error) throw new Error(`inbox companion: the supplier invoice's inbox items could not be read: ${error.message}`)
  const out: PairedReceiptFollow[] = []
  for (const row of (data ?? []) as Array<{ id: string }>) out.push(await followPairedReceipt(ctx, row.id))
  return out
}
