/**
 * The human steps of a payment order before BankID: approve (attest),
 * un-approve (back to draft to edit), and cancel.
 *
 * Every step is a compare-and-set on the current status, written through the
 * service role (browser sessions cannot write payment orders) after the door
 * has established a non-viewer member. The database trigger re-checks the
 * move, so a race ends in a refusal, never in a skipped step.
 */

import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { getPaymentInitiationProvider } from '@/lib/payments/initiation/provider'
import { createServiceClient } from '@/lib/supabase/server'
import { buildPartyContext } from './party'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'

async function loadOrders(ctx: OperationContext, orderIds: string[]): Promise<PaymentOrderRow[]> {
  const { data, error } = await ctx.supabase
    .from('payment_orders')
    .select('*')
    .eq('company_id', ctx.companyId)
    .in('id', orderIds)
  if (error) throw error
  return (data ?? []) as PaymentOrderRow[]
}

export async function approvePaymentOrders(
  ctx: OperationContext,
  input: { orderIds: string[]; confirmChangedPayee?: boolean },
): Promise<OperationOutcome<{ approved: string[] }>> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const orders = await loadOrders(ctx, ids)
  if (orders.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const notDraft = orders.filter((o) => o.status !== 'draft')
  if (notDraft.length > 0) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { orders: notDraft.map((o) => ({ id: o.id, status: o.status })) } }
  }
  const changed = orders.filter((o) => o.payee_check === 'changed')
  if (changed.length > 0 && !input.confirmChangedPayee) {
    return { ok: false, code: 'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED', details: { orders: changed.map((o) => o.id) } }
  }

  const writer = createServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await writer
    .from('payment_orders')
    .update({ status: 'approved', approved_by: ctx.userId, approved_at: now })
    .eq('company_id', ctx.companyId)
    .eq('status', 'draft')
    .in('id', ids)
    .select('id')
  if (error) throw error
  const approved = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  await logPaymentOrderEvents(
    writer,
    approved.map((id) => ({
      company_id: ctx.companyId,
      payment_order_id: id,
      event_type: 'approved',
      from_status: 'draft',
      to_status: 'approved',
      actor_user_id: ctx.userId,
      detail: changed.some((o) => o.id === id) ? { confirmed_changed_payee: true } : {},
    })),
  )
  if (approved.length !== ids.length) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { approved } }
  }
  return { ok: true, data: { approved } }
}

export async function unapprovePaymentOrders(
  ctx: OperationContext,
  input: { orderIds: string[] },
): Promise<OperationOutcome<{ unapproved: string[] }>> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const writer = createServiceClient()
  const { data, error } = await writer
    .from('payment_orders')
    .update({ status: 'draft', approved_by: null, approved_at: null })
    .eq('company_id', ctx.companyId)
    .eq('status', 'approved')
    .in('id', ids)
    .select('id')
  if (error) throw error
  const unapproved = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  await logPaymentOrderEvents(
    writer,
    unapproved.map((id) => ({
      company_id: ctx.companyId,
      payment_order_id: id,
      event_type: 'unapproved',
      from_status: 'approved',
      to_status: 'draft',
      actor_user_id: ctx.userId,
    })),
  )
  if (unapproved.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { unapproved } }
  return { ok: true, data: { unapproved } }
}

/**
 * Cancel one order. Before the bank has it (draft, approved) it is cancelled
 * here; after that the bank is asked first, and the order is cancelled only
 * when the bank confirms. An executed payment cannot be cancelled.
 */
export async function cancelPaymentOrder(
  ctx: OperationContext,
  input: { orderId: string; signer?: { ipAddress: string | null; userAgent: string | null } },
): Promise<OperationOutcome<{ cancelled: boolean; status: string }>> {
  const [order] = await loadOrders(ctx, [input.orderId])
  if (!order) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const writer = createServiceClient()
  const now = new Date().toISOString()

  const markCancelled = async (from: string, providerStatus: string | null) => {
    const { data, error } = await writer
      .from('payment_orders')
      .update({
        status: 'cancelled',
        cancelled_by: ctx.userId,
        cancelled_at: now,
        // Only what the bank confirmed; undefined keys are left out of the request.
        provider_status: providerStatus ?? undefined,
        provider_status_at: providerStatus ? now : undefined,
      })
      .eq('id', order.id)
      .eq('company_id', ctx.companyId)
      .eq('status', from)
      .select('id')
    if (error) throw error
    const done = (data ?? []).length === 1
    if (done) {
      await logPaymentOrderEvents(writer, [
        {
          company_id: ctx.companyId,
          payment_order_id: order.id,
          event_type: 'cancelled',
          from_status: from,
          to_status: 'cancelled',
          provider_status: providerStatus,
          actor_user_id: ctx.userId,
        },
      ])
    }
    return done
  }

  if (order.status === 'draft' || order.status === 'approved') {
    const done = await markCancelled(order.status, null)
    return done ? { ok: true, data: { cancelled: true, status: 'cancelled' } } : { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' }
  }
  if (!['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'].includes(order.status) || !order.provider_payment_id) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { status: order.status } }
  }

  const provider = getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  const party = await buildPartyContext(ctx, order, { personalNumber: null, ipAddress: input.signer?.ipAddress ?? null, userAgent: input.signer?.userAgent ?? null })
  if (!party.ok) return party.outcome
  await logPaymentOrderEvents(writer, [
    { company_id: ctx.companyId, payment_order_id: order.id, event_type: 'cancel_requested', from_status: order.status, actor_user_id: ctx.userId },
  ])
  const result = await provider.cancelPayment(party.ctx, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
  if (!result.cancelled) return { ok: true, data: { cancelled: false, status: order.status } }
  const done = await markCancelled(order.status, result.providerStatus)
  return { ok: true, data: { cancelled: done, status: done ? 'cancelled' : order.status } }
}
