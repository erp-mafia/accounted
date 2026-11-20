/**
 * Ingest matcher: the debit of a bank payment Accounted initiated
 * (findOrderForDebit: the order's end-to-end id, or a unique amount, account
 * and date match).
 *
 * The owner approved and BankID-signed exactly this payment, so the bank's
 * matching debit is the confirmation: the supplier payment is booked here,
 * as the user who approved the order, and the payment row settles the order
 * (settleOrderWithDebit). When the booking is refused (a locked period, an
 * invoice no longer open, amounts apart) the row keeps the suggestion a
 * person confirms. Runs before the supplier heuristics: it is the strongest
 * evidence there is.
 *
 * The debit of an order without an invoice (skattekonto, salary) only links
 * the order (findLinkableOrderForDebit, linkOrderToDebit): the row is booked
 * the way it always is, so the pass answers 'none' and the matchers after it
 * and the mapping rule still run on it. A link that fails here (a client
 * that may not write orders) is made by the status sync's sweep.
 */
import type { IngestBatch, IngestMatcher } from '@/lib/transactions/ingest-matcher'
import type { RawTransaction, Transaction } from '@/types'
import { findLinkableOrderForDebit, findOrderForDebit, type OrderDebit } from './debit-match'
import { linkOrderToDebit, loadOpenPaymentOrders, PAYMENT_ORDER_MATCH_METHOD, settleOrderWithDebit } from './auto-settle'
import type { PaymentOrderRow } from './types'

/**
 * The inserted row as findOrderForDebit reads it. The stored row wins (its
 * description is the display title, the original is kept beside it); the raw
 * row fills what a store path did not return.
 */
export function debitForOrderMatch(stored: Transaction, raw: RawTransaction): OrderDebit {
  return {
    amount: stored.amount ?? raw.amount,
    currency: stored.currency ?? raw.currency,
    date: stored.date ?? raw.date,
    value_date: stored.value_date ?? raw.value_date ?? null,
    cash_account_id: stored.cash_account_id ?? null,
    description: stored.original_description ?? stored.description ?? raw.description,
    reference: stored.reference ?? raw.reference ?? null,
    counterparty_iban: stored.counterparty_iban ?? raw.counterparty_iban ?? null,
    counterparty_account: stored.counterparty_account ?? raw.counterparty_account ?? null,
    end_to_end_id: stored.end_to_end_id ?? raw.end_to_end_id ?? null,
  }
}

/** Link the order without an invoice this debit pays, if one; never books and never explains the row. */
async function linkOrderWithoutInvoice(
  batch: IngestBatch,
  open: readonly PaymentOrderRow[],
  tx: Transaction,
  debit: OrderDebit,
): Promise<void> {
  const link = findLinkableOrderForDebit(debit, open)
  if (!link) return
  // One debit per order per batch.
  batch.claims.add('payment_order', link.order.id)
  const linked = await linkOrderToDebit(batch.supabase, { order: link.order, transaction: tx, basis: link.basis, log: batch.log })
  batch.log.info(linked.ok ? 'payment order linked to its debit' : 'payment order left for the status sync', {
    orderId: link.order.id,
    transactionId: tx.id,
    basis: link.basis,
    ...(linked.ok ? {} : { reason: linked.reason }),
  })
}

interface PaymentOrderIngestState {
  /** The company's open orders, read once per batch; a claimed order is never matched again. */
  orders: readonly PaymentOrderRow[]
}

export const paymentOrderIngestMatcher: IngestMatcher<PaymentOrderIngestState> = {
  id: 'payment-order',
  order: 310,
  module: 'payments',
  direction: 'expense',
  onReread: true,
  // Read once per batch; never throws.
  async prepare(batch) {
    return { orders: await loadOpenPaymentOrders(batch.supabase, batch.companyId) }
  },
  async match(batch, state, { tx, raw, reread }) {
    const open = state.orders.filter((o) => !batch.claims.has('payment_order', o.id))
    if (open.length === 0) return 'none'
    const debit = debitForOrderMatch(tx, raw)
    const match = findOrderForDebit(debit, open)
    if (!match) {
      await linkOrderWithoutInvoice(batch, open, tx, debit)
      return 'none'
    }
    const invoiceId = match.order.supplier_invoice_id
    if (!invoiceId || batch.claims.has('supplier_invoice', invoiceId)) return 'none'

    const order = match.order
    // One debit per order per batch, booked or suggested.
    batch.claims.add('payment_order', order.id)
    const settled = await settleOrderWithDebit(batch.supabase, {
      order,
      transaction: tx,
      confidence: match.confidence,
      basis: match.basis,
      log: batch.log,
    })
    if (settled.ok) {
      batch.claims.add('supplier_invoice', invoiceId)
      batch.pools.supplierInvoices = batch.pools.supplierInvoices.filter((inv) => inv.id !== invoiceId)
      batch.result.auto_matched_invoices++
      return 'explained'
    }
    if (reread && tx.potential_supplier_invoice_id === invoiceId) {
      // The row already points at this invoice: nothing new to say.
      batch.claims.add('supplier_invoice', invoiceId)
      return 'explained'
    }
    const { error: hintError } = await batch.supabase
      .from('transactions')
      .update({ potential_supplier_invoice_id: invoiceId })
      .eq('id', tx.id)
    // A hint that did not land leaves the row to the heuristics.
    if (hintError) return 'none'
    await batch.logMatch(tx.id, 'auto_suggested', {
      supplierInvoiceId: invoiceId,
      matchConfidence: match.confidence,
      matchMethod: PAYMENT_ORDER_MATCH_METHOD,
      newState: {
        payment_order_id: order.id,
        matched_by: match.basis,
        auto_settle_refused: settled.reason,
        ...(settled.code ? { code: settled.code } : {}),
      },
    })
    batch.claims.add('supplier_invoice', invoiceId)
    batch.pools.supplierInvoices = batch.pools.supplierInvoices.filter((inv) => inv.id !== invoiceId)
    batch.result.auto_matched_invoices++
    return 'explained'
  },
}
