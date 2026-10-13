/**
 * Settling a bank payment order with its own debit, without a person.
 *
 * The owner approved and BankID-signed exactly this payment (payment_orders),
 * so the bank's matching debit in the feed is the confirmation: the supplier
 * payment is booked as the user who approved the order, through the same
 * function the match route books with (bookSupplierBankMatch), and the
 * payment row settles the order. Two callers share this file:
 *
 *   - ingest step 3a (lib/transactions/ingest.ts): a debit that has just been
 *     imported, matched against the company's open orders
 *     (loadOpenPaymentOrders + findOrderForDebit);
 *   - the status sync's sweep (sync.ts): an executed, unsettled order whose
 *     debit was imported earlier and is still unbooked.
 *
 * Every refusal is a refusal, never a throw: the callers fall back to today's
 * suggestion (ingest) or leave the order for the next run (the sweep). Right
 * before booking, the order and the transaction are read again, so a debit
 * is never booked twice and an order never settled twice.
 *
 * The settlement trigger (settle_payment_order_on_supplier_payment) links an
 * executed order by a payment of its amount, and any signed order by a debit
 * carrying its end-to-end id. An order the bank has not yet reported executed,
 * matched by amount, account and date, is outside the trigger's rule: it is
 * linked here, with a 'matched' event that says the debit decided it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import { isMatchableSupplierInvoiceStatus } from '@/lib/invoices/matchable-statuses'
import type { SupplierInvoice, Transaction } from '@/types'
import { DEBIT_SETTLEABLE_ORDER_STATUSES, isDebitSettleableOrder, type DebitMatchBasis } from './debit-match'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

/** How far back an open order is still a candidate for a debit in a new batch. */
export const OPEN_ORDER_LOOKBACK_DAYS = 60

/** The match method the log and the order's event carry for a debit-settled order. */
export const PAYMENT_ORDER_MATCH_METHOD = 'payment_order'

/**
 * The company's open bank payment orders a debit may settle: signed at the
 * bank, invoice attached, not yet matched, created within the lookback.
 * Never throws: the batch's heuristics run without it.
 */
export async function loadOpenPaymentOrders(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<PaymentOrderRow[]> {
  try {
    const since = new Date(now.getTime() - OPEN_ORDER_LOOKBACK_DAYS * 86_400_000).toISOString()
    const { data, error } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('company_id', companyId)
      .in('status', [...DEBIT_SETTLEABLE_ORDER_STATUSES])
      .is('supplier_invoice_payment_id', null)
      .not('supplier_invoice_id', 'is', null)
      .not('provider_payment_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) return []
    return ((data ?? []) as PaymentOrderRow[]).filter(isDebitSettleableOrder)
  } catch {
    return []
  }
}

export type SettleRefusal =
  | 'order_not_open'
  | 'transaction_not_open'
  | 'amount_mismatch'
  | 'invoice_not_matchable'
  | 'booking_failed'

export type SettleOrderWithDebitResult =
  | {
      ok: true
      journalEntryId: string
      /** False when the payment row landed but the order could not be linked: a person resolves it. */
      orderLinked: boolean
      linkedBy: 'trigger' | 'debit' | null
    }
  | {
      ok: false
      reason: SettleRefusal
      /** The structured error code of a booking refusal (bookSupplierBankMatch). */
      code?: string
      details?: Record<string, unknown>
    }

export interface SettleOrderWithDebitArgs {
  /** The order as the caller matched it; it is read again before booking. */
  order: Pick<PaymentOrderRow, 'id' | 'company_id'>
  /** The debit as the caller matched it; it is read again before booking. */
  transaction: Pick<Transaction, 'id'>
  confidence: number
  basis: DebitMatchBasis
  log: Logger
}

type InvoiceRow = SupplierInvoice & { company_id: string }

/**
 * Book `transaction` as the payment of `order`'s invoice and settle the
 * order. Never throws.
 */
export async function settleOrderWithDebit(
  supabase: SupabaseClient,
  args: SettleOrderWithDebitArgs,
): Promise<SettleOrderWithDebitResult> {
  const { confidence, basis, log } = args
  const companyId = args.order.company_id
  try {
    // The order, as it is now: another debit or a person may have settled it
    // since the caller read it.
    const { data: orderData } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('id', args.order.id)
      .eq('company_id', companyId)
      .maybeSingle()
    const order = (orderData ?? null) as PaymentOrderRow | null
    if (!order || !isDebitSettleableOrder(order) || !order.supplier_invoice_id) {
      return { ok: false, reason: 'order_not_open' }
    }

    // The debit, as it is now: unbooked, unlinked, not ignored, an expense.
    const { data: txData } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', args.transaction.id)
      .eq('company_id', companyId)
      .maybeSingle()
    const transaction = (txData ?? null) as Transaction | null
    if (
      !transaction ||
      transaction.journal_entry_id ||
      transaction.supplier_invoice_id ||
      transaction.is_ignored ||
      !(transaction.amount < 0)
    ) {
      return { ok: false, reason: 'transaction_not_open' }
    }

    // The debit must move exactly what the order said, in its currency. An
    // end-to-end match of another amount (a partial execution, a fee the bank
    // took on the same row) is still only a suggestion for a person.
    if (
      (transaction.currency ?? 'SEK') !== order.currency ||
      roundOre(Math.abs(transaction.amount)) !== roundOre(Number(order.amount))
    ) {
      return {
        ok: false,
        reason: 'amount_mismatch',
        details: { transaction_amount: transaction.amount, order_amount: order.amount },
      }
    }

    // The invoice with its supplier and items (the cash-method builder books
    // the items), and still open for at least the order's amount.
    const { data: invoiceData } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', order.supplier_invoice_id)
      .eq('company_id', companyId)
      .maybeSingle()
    const invoice = (invoiceData ?? null) as InvoiceRow | null
    const remaining = invoice ? Number(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)) : 0
    if (!invoice || !isMatchableSupplierInvoiceStatus(invoice.status) || remaining + 0.005 < Number(order.amount)) {
      return {
        ok: false,
        reason: 'invoice_not_matchable',
        details: { invoice_status: invoice?.status ?? null, remaining_amount: invoice ? remaining : null },
      }
    }

    const booked = await bookSupplierBankMatch(supabase, {
      transaction,
      invoice,
      // The person who approved the payment books it, not the feed's sender.
      userId: order.user_id,
      companyId,
      log,
      match: {
        action: 'auto_matched',
        method: PAYMENT_ORDER_MATCH_METHOD,
        confidence,
        newState: { payment_order_id: order.id, confidence, matched_by: basis },
      },
    })
    if (!booked.ok) {
      return { ok: false, reason: 'booking_failed', code: booked.code, details: booked.details }
    }

    const link = await linkOrderToPayment(supabase, order, transaction, { confidence, basis, log })
    return { ok: true, journalEntryId: booked.journalEntryId, orderLinked: link !== null, linkedBy: link }
  } catch (err) {
    log.warn('payment order could not be settled with its debit', {
      orderId: args.order.id,
      transactionId: args.transaction.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'booking_failed', code: 'UNEXPECTED_ERROR' }
  }
}

/**
 * The trigger settles an executed order by a payment of its amount; this
 * links what the trigger left: an order the bank has not reported executed
 * yet, or a payment row whose debt differs from the order by öre (3740).
 * Returns who linked the order, or null when nobody could.
 */
async function linkOrderToPayment(
  supabase: SupabaseClient,
  order: PaymentOrderRow,
  transaction: Transaction,
  evidence: { confidence: number; basis: DebitMatchBasis; log: Logger },
): Promise<'trigger' | 'debit' | null> {
  const { data: afterData } = await supabase
    .from('payment_orders')
    .select('id, status, supplier_invoice_payment_id')
    .eq('id', order.id)
    .eq('company_id', order.company_id)
    .maybeSingle()
  const after = afterData as Pick<PaymentOrderRow, 'id' | 'status' | 'supplier_invoice_payment_id'> | null
  if (!after) return null
  if (after.supplier_invoice_payment_id) return 'trigger'

  const { data: paymentData } = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', order.company_id)
    .eq('transaction_id', transaction.id)
    .eq('supplier_invoice_id', order.supplier_invoice_id as string)
    .maybeSingle()
  const paymentId = (paymentData as { id: string } | null)?.id
  if (!paymentId) {
    evidence.log.warn('payment row of a debit-settled order not found; order left unsettled', {
      orderId: order.id,
      transactionId: transaction.id,
    })
    return null
  }

  const now = new Date().toISOString()
  const { data: linked, error } = await supabase
    .from('payment_orders')
    .update({
      status: 'executed',
      // Undefined keys are left out of the request: an order the bank already
      // reported executed keeps the bank's time.
      executed_at: after.status === 'executed' ? undefined : now,
      supplier_invoice_payment_id: paymentId,
      matched_transaction_id: transaction.id,
      matched_at: now,
    })
    .eq('id', order.id)
    .eq('company_id', order.company_id)
    .eq('status', after.status)
    .is('supplier_invoice_payment_id', null)
    .select('id')
  if (error || (linked ?? []).length !== 1) {
    evidence.log.warn('debit-settled payment order could not be linked to its payment row', {
      orderId: order.id,
      paymentId,
      error: error?.message ?? null,
    })
    return null
  }
  await logPaymentOrderEvents(
    supabase,
    [
      {
        company_id: order.company_id,
        payment_order_id: order.id,
        event_type: 'matched',
        from_status: after.status,
        to_status: 'executed',
        actor_user_id: null,
        detail: {
          supplier_invoice_payment_id: paymentId,
          transaction_id: transaction.id,
          by: 'debit',
          matched_by: evidence.basis,
          confidence: evidence.confidence,
        },
      },
    ],
    evidence.log,
  )
  return 'debit'
}
