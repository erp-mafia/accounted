/**
 * Letting go of an order the bank holds nothing for, after cancelling its
 * payment at the bank when there is one. Shared by signing (a signing that
 * cannot go on, a restart that finds a payment gone) and the status sync (an
 * invoice that closed while its payment waited unsigned).
 *
 * The rules (the payment_orders migration, rules 2 and 5):
 *   - Only a confirmed cancel counts (PaymentCancelResult 'cancelled').
 *   - The confirmed cancel and the release are written together, by
 *     release_payment_order, so neither is ever kept without the other.
 *   - An order whose invoice no longer needs paying is cancelled, not
 *     approved again.
 *   - Before any bank call the order is read again: one that moved on since
 *     the caller saw it (signed meanwhile, moved to another signing) is left
 *     alone.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import {
  PaymentProviderError,
  providerWriteOutcome,
  type PaymentCancelResult,
  type PaymentInitiationProvider,
  type PaymentPartyContext,
} from '@/lib/payments/initiation/provider'
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

const PAYABLE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

/** Who is acting: a person in a request, or the status sync (no user). */
export interface ReleaseActor {
  userId: string | null
  log: Logger
}

export type ReleaseResult = 'approved' | 'cancelled' | 'moved' | 'create_in_progress' | 'error'

/**
 * release_payment_order: back to approved (or cancelled when the invoice no
 * longer needs paying), recording a confirmed cancel in the same transaction.
 * Tried twice; a release that cannot be written after a bank cancel goes to
 * the error log with its ids, and the status sync later reads the payment
 * cancelled at the bank.
 */
export async function releasePaymentOrder(
  writer: SupabaseClient,
  actor: ReleaseActor,
  input: {
    companyId: string
    orderId: string
    batchId: string | null
    providerPaymentId: string | null
    providerStatus: string | null
    reason: string
    errorCode?: string | null
  },
): Promise<ReleaseResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await writer.rpc('release_payment_order', {
        p_company_id: input.companyId,
        p_order_id: input.orderId,
        p_batch_id: input.batchId,
        p_provider_payment_id: input.providerPaymentId,
        p_provider_status: input.providerStatus,
        p_reason: input.reason,
        p_error_code: input.errorCode ?? null,
        p_user_id: actor.userId,
      })
      if (!error) {
        const result = data as { ok: boolean; status?: 'approved' | 'cancelled'; code?: string }
        if (result.ok && result.status) return result.status
        return result.code === 'create_in_progress' ? 'create_in_progress' : 'moved'
      }
    } catch {
      // tried again below
    }
  }
  actor.log.error('payment order could not be released', undefined, {
    orderId: input.orderId,
    batchId: input.batchId,
    providerPaymentId: input.providerPaymentId,
    reason: input.reason,
  })
  return 'error'
}

/** Orders whose invoice no longer needs paying: paid, credited, reversed, gone, or reduced below the order. */
export async function unpayableOrders(writer: SupabaseClient, orders: PaymentOrderRow[]): Promise<Set<string>> {
  const invoiceIds = [...new Set(orders.map((o) => o.supplier_invoice_id).filter((id): id is string => Boolean(id)))]
  if (invoiceIds.length === 0) return new Set()
  const { data, error } = await writer
    .from('supplier_invoices')
    .select('id, company_id, status, is_credit_note, remaining_amount')
    .in('id', invoiceIds)
  if (error) throw error
  const invoices = new Map(
    ((data ?? []) as Array<{ id: string; company_id: string; status: string; is_credit_note: boolean | null; remaining_amount: number | null }>).map(
      (invoice) => [invoice.id, invoice],
    ),
  )
  return new Set(
    orders
      .filter((order) => {
        const invoice = order.supplier_invoice_id ? invoices.get(order.supplier_invoice_id) : undefined
        return (
          !invoice ||
          invoice.company_id !== order.company_id ||
          Boolean(invoice.is_credit_note) ||
          !PAYABLE.has(invoice.status) ||
          Number(order.amount) > Number(invoice.remaining_amount ?? 0) + 0.005
        )
      })
      .map((order) => order.id),
  )
}

async function askBankToCancel(
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  order: PaymentOrderRow,
  log: Logger,
): Promise<{ answer: PaymentCancelResult | null; error: unknown }> {
  try {
    return { answer: await provider.cancelPayment(party, order.provider_payment_id as string, order.provider_payment_product ?? 'domestic'), error: null }
  } catch (error) {
    log.warn('bank payment could not be cancelled', { orderId: order.id, code: error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR' })
    return { answer: null, error }
  }
}

/**
 * The bank holds a payment for this order in this signing: cancel it there,
 * and only a confirmed cancel lets the order go. 'kept' leaves the order
 * submitted with its payment id, for the status sync or a person; 'moved'
 * means the order was no longer this payment in this signing, so nothing was
 * asked of the bank.
 */
export async function cancelAndRelease(
  writer: SupabaseClient,
  actor: ReleaseActor & { companyId: string },
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batchId: string,
  order: PaymentOrderRow,
  reason: string,
): Promise<'released' | 'cancelled' | 'kept' | 'moved'> {
  const paymentId = order.provider_payment_id
  if (!paymentId) return 'moved'
  const { data: current, error } = await writer
    .from('payment_orders')
    .select('id, status, outcome_unknown_at')
    .eq('id', order.id)
    .eq('company_id', actor.companyId)
    .eq('batch_id', batchId)
    .eq('provider_payment_id', paymentId)
    .maybeSingle()
  const now = current as { status: string; outcome_unknown_at: string | null } | null
  if (error || !now || (now.status !== 'submitted' && now.status !== 'awaiting_signature') || now.outcome_unknown_at) return 'moved'

  // A failed signing leaves its orders signable again, never mid-signing.
  if (now.status === 'awaiting_signature') {
    await writer
      .from('payment_orders')
      .update({ status: 'submitted' })
      .eq('id', order.id)
      .eq('company_id', actor.companyId)
      .eq('batch_id', batchId)
      .eq('status', 'awaiting_signature')
  }

  const { answer } = await askBankToCancel(provider, party, order, actor.log)
  if (answer?.outcome !== 'cancelled') {
    await logPaymentOrderEvents(writer, [
      {
        company_id: actor.companyId,
        payment_order_id: order.id,
        batch_id: batchId,
        event_type: 'error',
        provider_status: answer?.providerStatus ?? null,
        actor_user_id: actor.userId,
        detail: { code: 'BANK_CANCEL_NOT_CONFIRMED', answer: answer?.outcome ?? 'no_answer', provider_payment_id: paymentId, reason },
      },
    ], actor.log)
    return 'kept'
  }
  const released = await releasePaymentOrder(writer, actor, {
    companyId: actor.companyId,
    orderId: order.id,
    batchId,
    providerPaymentId: paymentId,
    providerStatus: answer.providerStatus,
    reason,
  })
  if (released === 'approved') return 'released'
  if (released === 'cancelled') return 'cancelled'
  actor.log.error('bank cancelled a payment but its order was not released', undefined, {
    orderId: order.id,
    batchId,
    providerPaymentId: paymentId,
    result: released,
  })
  return 'kept'
}

/**
 * An order's payment waits unsigned at the bank and its invoice no longer
 * needs paying: cancel the payment there. A confirmed cancel cancels the
 * order (release_payment_order finds the invoice closed). A cancel that never
 * reached the bank is tried again later ('retry'); any other answer holds the
 * order for a person ('held'), recorded as a cancel_requested event that the
 * status sync does not repeat.
 */
export async function cancelForClosedInvoice(
  writer: SupabaseClient,
  actor: ReleaseActor,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  order: PaymentOrderRow,
): Promise<'cancelled' | 'released' | 'held' | 'retry' | 'moved'> {
  const paymentId = order.provider_payment_id
  if (!paymentId || order.status !== 'submitted') return 'moved'
  const { data: current } = await writer
    .from('payment_orders')
    .select('id')
    .eq('id', order.id)
    .eq('company_id', order.company_id)
    .eq('status', 'submitted')
    .eq('provider_payment_id', paymentId)
    .maybeSingle()
  if (!current) return 'moved'
  const { answer, error } = await askBankToCancel(provider, party, order, actor.log)
  if (!answer && providerWriteOutcome(error) === 'not_sent') return 'retry'
  if (answer?.outcome === 'cancelled') {
    const released = await releasePaymentOrder(writer, actor, {
      companyId: order.company_id,
      orderId: order.id,
      batchId: order.batch_id,
      providerPaymentId: paymentId,
      providerStatus: answer.providerStatus,
      reason: 'INVOICE_CLOSED',
    })
    if (released === 'cancelled') return 'cancelled'
    if (released === 'approved') return 'released'
    return released === 'moved' ? 'moved' : 'held'
  }
  await logPaymentOrderEvents(writer, [
    {
      company_id: order.company_id,
      payment_order_id: order.id,
      batch_id: order.batch_id,
      event_type: 'cancel_requested',
      from_status: order.status,
      provider_status: answer?.providerStatus ?? null,
      actor_user_id: actor.userId,
      detail: {
        source: 'invoice_closed',
        provider_payment_id: paymentId,
        answer: answer?.outcome ?? 'no_answer',
        provider_code: error instanceof PaymentProviderError ? error.code : null,
      },
    },
  ], actor.log)
  return 'held'
}
