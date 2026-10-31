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
 *
 * An order without a supplier invoice (skattekonto, salary) has no payment
 * row and no trigger: its debit is booked the way it always is (the
 * skattekonto account, the salary voucher), and linkOrderToDebit only links
 * the order to it and moves it to executed. A bank that keeps answering RCVD
 * after the BankID finished would otherwise leave the order waiting for
 * good. Nothing is booked there.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import { isMatchableSupplierInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import type { SupplierInvoice, Transaction } from '@/types'
import {
  DEBIT_LINKABLE_ORDER_STATUSES,
  debitOfTransaction,
  findLinkableOrderForDebit,
  isDebitLinkableOrder,
  isDebitSettleableOrder,
  type DebitLinkBasis,
  type DebitMatchBasis,
} from './debit-match'
import { SIGNING_FINISHED_BATCH_STATUSES } from './status'
import { logPaymentOrderEvents, type PaymentOrderBatchRow, type PaymentOrderRow } from './types'

/** How far back an open order is still a candidate for a debit in a new batch. */
export const OPEN_ORDER_LOOKBACK_DAYS = 60

/** The match method the log and the order's event carry for a debit-settled order. */
export const PAYMENT_ORDER_MATCH_METHOD = 'payment_order'

/**
 * The company's open bank payment orders a debit may settle or link, created
 * within the lookback: signed at the bank and not yet matched, with an
 * invoice (isDebitSettleableOrder, booked by its debit) or without one
 * (isDebitLinkableOrder, only linked). Never throws: the batch's heuristics
 * run without it.
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
      // The settleable statuses and awaiting_signature, for an order without
      // an invoice whose signing finished while the bank still answers RCVD.
      .in('status', [...DEBIT_LINKABLE_ORDER_STATUSES])
      .is('supplier_invoice_payment_id', null)
      .not('provider_payment_id', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(500)
    if (error) return []
    const orders = await withFinishedSignings(supabase, Array.isArray(data) ? (data as PaymentOrderRow[]) : [])
    return orders.filter((order) => isDebitSettleableOrder(order) || isDebitLinkableOrder(order))
  } catch {
    return []
  }
}

/**
 * The orders with signed_at filled in from their signing where the order
 * itself has none: an order without an invoice still awaiting_signature
 * whose BankID finished (the batch is signed, or waits for a second signer)
 * while the bank keeps answering RCVD (isBankConfirming). Only the copy in
 * memory changes; it is what isDebitLinkableOrder reads. Never throws: a
 * failed read leaves every such order unsigned, and so unlinked.
 */
export async function withFinishedSignings<T extends Pick<PaymentOrderRow, 'company_id' | 'status' | 'signed_at' | 'batch_id' | 'supplier_invoice_id'>>(
  supabase: SupabaseClient,
  orders: T[],
): Promise<T[]> {
  const waiting = orders.filter((o) => o.status === 'awaiting_signature' && !o.signed_at && o.batch_id && o.supplier_invoice_id == null)
  if (waiting.length === 0) return orders
  try {
    const { data, error } = await supabase
      .from('payment_order_batches')
      .select('id, company_id, status, signed_at')
      .in('id', [...new Set(waiting.map((o) => o.batch_id as string))])
    if (error || !Array.isArray(data)) return orders
    const finished = new Map<string, Pick<PaymentOrderBatchRow, 'company_id' | 'signed_at'>>()
    for (const batch of data as Array<Pick<PaymentOrderBatchRow, 'id' | 'company_id' | 'status' | 'signed_at'>>) {
      if (batch.signed_at && SIGNING_FINISHED_BATCH_STATUSES.has(batch.status)) finished.set(batch.id, batch)
    }
    return orders.map((order) => {
      const batch = order.batch_id ? finished.get(order.batch_id) : undefined
      return waiting.includes(order) && batch && batch.company_id === order.company_id ? { ...order, signed_at: batch.signed_at } : order
    })
  } catch {
    // Safe to ignore: without the signings every order still awaiting_signature
    // stays unsigned, so nothing is linked; the next run reads them again.
    return orders
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
    // A row booked only through voucher links passes this read; the booking
    // below refuses it (MATCH_SI_TX_ALREADY_BOOKED, accounted#58).
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
      // The debit of an order the owner already signed, paired by the debit
      // matcher: nobody chose this bank row for the invoice.
      linkBasis: {
        basis: basis === 'end_to_end_id' ? 'rule_ocr_reference' : basis === 'payee' ? 'rule_counterparty' : 'rule_amount_date',
        evidence: { rule_id: `${PAYMENT_ORDER_MATCH_METHOD}:${basis}`, score: confidence },
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

export type LinkRefusal =
  | 'order_not_linkable'
  | 'transaction_not_open'
  | 'debit_does_not_match'
  | 'transaction_linked_elsewhere'
  | 'link_failed'

export type LinkOrderToDebitResult = { ok: true; fromStatus: PaymentOrderRow['status'] } | { ok: false; reason: LinkRefusal }

export interface LinkOrderToDebitArgs {
  /** The order as the caller matched it (findLinkableOrderForDebit); it is read again before the link. */
  order: Pick<PaymentOrderRow, 'id' | 'company_id'>
  /** The debit as the caller matched it; it is read again before the link. */
  transaction: Pick<Transaction, 'id'>
  basis: DebitLinkBasis
  log: Logger
}

/**
 * Link an order without a supplier invoice (skattekonto, salary) to its own
 * debit and move it to executed: the money left the account, whatever the
 * bank's status API still says. Books nothing and writes nothing on the
 * transaction: the row is booked the way it always is. The order, its
 * signing and the debit are read again first, so an unsigned order is never
 * linked, a debit never links two orders, and the update is a
 * compare-and-set on the status read. An order the bank already reported
 * executed keeps the bank's executed_at; any other gets the debit's day.
 * Never throws.
 */
export async function linkOrderToDebit(supabase: SupabaseClient, args: LinkOrderToDebitArgs): Promise<LinkOrderToDebitResult> {
  const companyId = args.order.company_id
  try {
    const { data: orderData } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('id', args.order.id)
      .eq('company_id', companyId)
      .maybeSingle()
    const read = (orderData ?? null) as PaymentOrderRow | null
    const [order] = read ? await withFinishedSignings(supabase, [read]) : []
    if (!order || !isDebitLinkableOrder(order)) return { ok: false, reason: 'order_not_linkable' }

    const { data: txData } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', args.transaction.id)
      .eq('company_id', companyId)
      .maybeSingle()
    const transaction = (txData ?? null) as Transaction | null
    if (!transaction || transaction.is_ignored || transaction.supplier_invoice_id || !(transaction.amount < 0)) {
      return { ok: false, reason: 'transaction_not_open' }
    }
    // The same rule the caller applied, on the rows as they are now.
    if (findLinkableOrderForDebit(debitOfTransaction(transaction), [order])?.order.id !== order.id) {
      return { ok: false, reason: 'debit_does_not_match' }
    }

    const { data: otherData, error: otherError } = await supabase
      .from('payment_orders')
      .select('id')
      .eq('company_id', companyId)
      .eq('matched_transaction_id', transaction.id)
      .limit(1)
    if (otherError) return { ok: false, reason: 'link_failed' }
    if (Array.isArray(otherData) && otherData.length > 0) return { ok: false, reason: 'transaction_linked_elsewhere' }

    const { data: linked, error } = await supabase
      .from('payment_orders')
      .update({
        status: 'executed',
        // Undefined keys are left out of the request: the bank's own time stays.
        executed_at: order.executed_at ? undefined : `${transaction.date}T00:00:00.000Z`,
        matched_transaction_id: transaction.id,
        matched_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('company_id', companyId)
      .eq('status', order.status)
      .is('matched_transaction_id', null)
      .is('supplier_invoice_id', null)
      .select('id')
    if (error || !Array.isArray(linked) || linked.length !== 1) {
      args.log.warn('payment order could not be linked to its debit', {
        orderId: order.id,
        transactionId: transaction.id,
        error: error?.message ?? null,
      })
      return { ok: false, reason: 'link_failed' }
    }
    await logPaymentOrderEvents(
      supabase,
      [
        {
          company_id: companyId,
          payment_order_id: order.id,
          event_type: 'matched',
          from_status: order.status,
          to_status: 'executed',
          provider_status: order.provider_status,
          actor_user_id: null,
          detail: {
            transaction_id: transaction.id,
            by: 'debit',
            method: PAYMENT_ORDER_MATCH_METHOD,
            matched_by: args.basis,
            purpose: order.purpose,
            debit_date: transaction.date,
          },
        },
      ],
      args.log,
    )
    return { ok: true, fromStatus: order.status }
  } catch (err) {
    args.log.warn('payment order could not be linked to its debit', {
      orderId: args.order.id,
      transactionId: args.transaction.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'link_failed' }
  }
}
