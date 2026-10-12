/**
 * The human steps of a payment order around BankID: approve (attest),
 * un-approve (back to draft to edit), cancel, and resolve an order the bank
 * cannot settle.
 *
 * Every step is a compare-and-set on the current status, written through the
 * service role (browser sessions cannot write payment orders) after the door
 * has established a non-viewer member. The database trigger re-checks the
 * move, so a race ends in a refusal, never in a skipped step.
 */

import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  getPaymentInitiationProvider,
  PAYMENT_NOT_FOUND,
  PaymentProviderError,
  type PaymentCancelOutcome,
  type PaymentCancelResult,
} from '@/lib/payments/initiation/provider'
import { createServiceClient } from '@/lib/supabase/server'
import { buildPartyContext } from './party'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'
import { executionDateFor } from '@/lib/payments/bank-days'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** What a person is told when the bank answered a cancel with anything but a confirmation. */
const CANCEL_ANSWER_CODES: Record<Exclude<PaymentCancelOutcome, 'cancelled'>, string> = {
  needs_authorisation: 'PAYMENT_CANCEL_NEEDS_SIGNING',
  too_late: 'PAYMENT_CANCEL_TOO_LATE',
  not_cancelled: 'PAYMENT_CANCEL_NOT_CONFIRMED',
}

const RESOLVE_CODES: Record<string, string> = {
  invalid_payload: 'VALIDATION_ERROR',
  not_found: 'PAYMENT_ORDER_NOT_FOUND',
  not_resolvable: 'PAYMENT_ORDER_NOT_RESOLVABLE',
  payment_not_found: 'PAYMENT_ORDER_PAYMENT_NOT_FOUND',
  payment_mismatch: 'PAYMENT_ORDER_PAYMENT_MISMATCH',
}

function providerFailure(error: unknown): { code: string; details: { provider_code: string } } {
  const providerCode = error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR'
  const unavailable = error instanceof PaymentProviderError && (error.retryable || error.outcomeUnknown)
  return { code: unavailable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: providerCode } }
}

/** A claimed order without a payment id whose create has not ended: on its way to the bank, or never started. */
function createUnfinished(order: PaymentOrderRow): boolean {
  return order.status === 'submitted' && !order.provider_payment_id && !order.outcome_unknown_at
}

async function loadOrders(ctx: OperationContext, orderIds: string[]): Promise<PaymentOrderRow[]> {
  const { data, error } = await ctx.supabase
    .from('payment_orders')
    .select('*')
    .eq('company_id', ctx.companyId)
    .in('id', orderIds)
  if (error) throw error
  return (data ?? []) as PaymentOrderRow[]
}

/**
 * Attest drafts. An order to an account no person has confirmed for the
 * supplier ('new') or that differs from the supplier card ('changed') needs
 * that invoice named in confirmedPayeeInvoiceIds: one confirmation per
 * invoice, never one flag for a whole selection.
 */
/**
 * The banking day an order gets for the date it carries: never earlier than
 * the first banking day after today, which is the earliest the provider takes.
 */
export function bankDayFor(requested: string | null | undefined, today: string): string | null {
  if (!requested) return null
  return executionDateFor(requested, today)
}

export async function approvePaymentOrders(
  ctx: OperationContext,
  input: { orderIds: string[]; confirmedPayeeInvoiceIds?: string[]; today?: string },
): Promise<OperationOutcome<{ approved: string[] }>> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const orders = await loadOrders(ctx, ids)
  if (orders.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const notDraft = orders.filter((o) => o.status !== 'draft')
  if (notDraft.length > 0) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { orders: notDraft.map((o) => ({ id: o.id, status: o.status })) } }
  }
  const confirmed = new Set(input.confirmedPayeeInvoiceIds ?? [])
  const needsConfirmation = orders.filter((o) => o.payee_check === 'changed' || o.payee_check === 'new')
  const unconfirmed = needsConfirmation.filter((o) => !o.supplier_invoice_id || !confirmed.has(o.supplier_invoice_id))
  if (unconfirmed.length > 0) {
    return {
      ok: false,
      code: 'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED',
      details: { orders: unconfirmed.map((o) => ({ id: o.id, supplier_invoice_id: o.supplier_invoice_id, payee_check: o.payee_check })) },
    }
  }

  const writer = createServiceClient()
  const now = new Date().toISOString()
  // A draft may still carry a day the bank cannot pay on (a weekend, a holiday,
  // a day that has passed since it was prepared): it moves to the next banking
  // day here, while the instruction can still change, and the event says so.
  const today = input.today ?? todayIsoStockholm()
  const movedDates = new Map<string, { from: string; to: string }>()
  for (const o of orders) {
    const to = bankDayFor(o.requested_execution_date, today)
    if (!to || to === o.requested_execution_date) continue
    const { error: moveError } = await writer
      .from('payment_orders')
      .update({ requested_execution_date: to })
      .eq('company_id', ctx.companyId)
      .eq('id', o.id)
      .eq('status', 'draft')
    if (moveError) throw moveError
    movedDates.set(o.id, { from: o.requested_execution_date, to })
  }
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
      detail: {
        ...(needsConfirmation.some((o) => o.id === id) ? { confirmed_payee: needsConfirmation.find((o) => o.id === id)?.payee_check } : {}),
        ...(movedDates.has(id) ? { date_moved_from: movedDates.get(id)!.from, date_moved_to: movedDates.get(id)!.to } : {}),
      },
    })),
    ctx.log,
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
    ctx.log,
  )
  if (unapproved.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { unapproved } }
  return { ok: true, data: { unapproved } }
}

/**
 * Cancel one order. Before the bank has it (draft, approved) it is cancelled
 * here; after that the bank is asked first, and the order is cancelled only
 * when the bank confirms (PaymentCancelResult 'cancelled'). An executed
 * payment cannot be cancelled.
 *
 * A claimed order without a payment id is not cancelled here: its create is
 * on its way to the bank (it ends by itself, PAYMENT_ORDER_CREATE_IN_PROGRESS),
 * or its outcome is unknown, which only a person resolves
 * (resolvePaymentOrder) after checking the online bank.
 */
export async function cancelPaymentOrder(
  ctx: OperationContext,
  input: {
    orderId: string
    signer?: { ipAddress: string | null; userAgent: string | null }
    /** Run the checks and say what a cancel would do (and whether the bank is asked) without writing or asking. */
    dryRun?: boolean
  },
): Promise<OperationOutcome<{ cancelled: boolean; status: string }>> {
  const [order] = await loadOrders(ctx, [input.orderId])
  if (!order) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const writer = createServiceClient()
  const now = new Date().toISOString()

  const markCancelled = async (from: string, bank: { providerStatus: string | null } | null) => {
    const providerStatus = bank?.providerStatus ?? null
    const attempt = () =>
      writer
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
    let { data, error } = await attempt()
    // After the bank confirmed the cancel the order must follow: one more try.
    if (error && bank) ({ data, error } = await attempt())
    if (error) {
      if (bank) {
        ctx.log.error('bank cancelled a payment but its order could not be cancelled', error, {
          orderId: order.id,
          providerPaymentId: order.provider_payment_id,
        })
      }
      throw error
    }
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
          detail: bank ? { provider_payment_id: order.provider_payment_id } : {},
        },
      ], ctx.log)
    }
    return done
  }

  if (order.status === 'draft' || order.status === 'approved') {
    if (input.dryRun) {
      return { ok: true, dryRun: true, preview: { payment_order_id: order.id, status: order.status, at_bank: false, bank_asked: false } }
    }
    const done = await markCancelled(order.status, null)
    return done ? { ok: true, data: { cancelled: true, status: 'cancelled' } } : { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' }
  }
  if (order.status === 'submitted' && !order.provider_payment_id) {
    return order.outcome_unknown_at
      ? { ok: false, code: 'PAYMENT_CANCEL_CONFIRMATION_REQUIRED', details: { payment_order_id: order.id, outcome_unknown: true } }
      : { ok: false, code: 'PAYMENT_ORDER_CREATE_IN_PROGRESS', details: { payment_order_id: order.id } }
  }
  if (!['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'].includes(order.status) || !order.provider_payment_id) {
    return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { status: order.status } }
  }

  const provider = getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  if (input.dryRun) {
    // The bank is asked only on the real run: a preview never cancels anything.
    return { ok: true, dryRun: true, preview: { payment_order_id: order.id, status: order.status, at_bank: true, bank_asked: true } }
  }
  const party = await buildPartyContext(ctx, order, { personalNumber: null, ipAddress: input.signer?.ipAddress ?? null, userAgent: input.signer?.userAgent ?? null })
  if (!party.ok) return party.outcome
  await logPaymentOrderEvents(writer, [
    { company_id: ctx.companyId, payment_order_id: order.id, event_type: 'cancel_requested', from_status: order.status, actor_user_id: ctx.userId },
  ], ctx.log)
  let answer: PaymentCancelResult
  try {
    answer = await provider.cancelPayment(party.ctx, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
  } catch (error) {
    const failure = providerFailure(error)
    ctx.log.warn('bank payment cancel failed', { orderId: order.id, code: failure.details.provider_code })
    return { ok: false, ...failure }
  }
  if (answer.outcome !== 'cancelled') {
    await logPaymentOrderEvents(writer, [
      {
        company_id: ctx.companyId,
        payment_order_id: order.id,
        event_type: 'error',
        from_status: order.status,
        provider_status: answer.providerStatus,
        actor_user_id: ctx.userId,
        detail: { code: 'BANK_CANCEL_NOT_CONFIRMED', answer: answer.outcome, provider_payment_id: order.provider_payment_id },
      },
    ], ctx.log)
    return { ok: false, code: CANCEL_ANSWER_CODES[answer.outcome], details: { payment_order_id: order.id, provider_status: answer.providerStatus } }
  }
  const done = await markCancelled(order.status, { providerStatus: answer.providerStatus })
  if (!done) {
    ctx.log.error('bank cancelled a payment but its order had moved on', undefined, { orderId: order.id, providerPaymentId: order.provider_payment_id })
  }
  return { ok: true, data: { cancelled: done, status: done ? 'cancelled' : order.status } }
}

/**
 * A person settles an order the bank cannot settle (resolve_payment_order in
 * the payments migration): one whose bank outcome is unknown, or one
 * stranded with a payment id the bank no longer knows or cannot be asked
 * about. Only the session route calls this, behind MFA; there is no machine
 * door, so an agent never resolves an order.
 *   not_at_bank: the payment never reached the bank or is no longer there.
 *     For an order with a payment id the bank is asked first, and only its
 *     "not found", or no provider to ask, lets this through.
 *   paid: the bank paid it; the person names the payment row on the invoice
 *     that booked it (an outcome-unknown order paid in the online bank, a
 *     stranded payment whose debit was matched by hand).
 */
export async function resolvePaymentOrder(
  ctx: OperationContext,
  input: {
    orderId: string
    resolution: 'not_at_bank' | 'paid'
    supplierInvoicePaymentId?: string
    signer?: { ipAddress: string | null; userAgent: string | null }
  },
): Promise<OperationOutcome<{ status: string }>> {
  const [order] = await loadOrders(ctx, [input.orderId])
  if (!order) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  if (createUnfinished(order)) return { ok: false, code: 'PAYMENT_ORDER_CREATE_IN_PROGRESS', details: { payment_order_id: order.id } }

  let bankAnswer: 'not_found' | 'no_provider' | null = null
  if (input.resolution === 'not_at_bank' && order.provider_payment_id) {
    const provider = getPaymentInitiationProvider(ctx.companyId)
    if (!provider) {
      bankAnswer = 'no_provider'
    } else {
      const party = await buildPartyContext(ctx, order, { personalNumber: null, ipAddress: input.signer?.ipAddress ?? null, userAgent: input.signer?.userAgent ?? null })
      if (!party.ok) return party.outcome
      try {
        await provider.getPaymentState(party.ctx, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
        // The bank knows the payment: it is cancelled there, never by a person's word.
        return { ok: false, code: 'PAYMENT_ORDER_AT_BANK', details: { payment_order_id: order.id } }
      } catch (error) {
        if (!(error instanceof PaymentProviderError && error.code === PAYMENT_NOT_FOUND)) return { ok: false, ...providerFailure(error) }
        bankAnswer = 'not_found'
      }
    }
  }

  const writer = createServiceClient()
  const { data, error } = await writer.rpc('resolve_payment_order', {
    p_company_id: ctx.companyId,
    p_order_id: order.id,
    p_resolution: input.resolution,
    p_user_id: ctx.userId,
    p_bank_answer: bankAnswer,
    p_supplier_invoice_payment_id: input.supplierInvoicePaymentId ?? null,
  })
  if (error) throw error
  const result = data as { ok: boolean; status?: string; code?: string; details?: unknown }
  if (!result.ok || !result.status) {
    return {
      ok: false,
      code: RESOLVE_CODES[result.code ?? ''] ?? 'PAYMENT_ORDERS_WRONG_STATUS',
      details: { resolve_code: result.code, resolve_details: result.details as Record<string, unknown> | undefined },
    }
  }
  return { ok: true, data: { status: result.status } }
}
