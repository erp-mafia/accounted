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
  type PaymentInitiationProvider,
  type PaymentPartyContext,
  type ProviderPaymentState,
} from '@/lib/payments/initiation/provider'
import { createServiceClient } from '@/lib/supabase/server'
import { applyProviderState } from './apply-state'
import { buildPartyContext } from './party'
import { SIGNING_FINISHED_BATCH_STATUSES, type PaymentOrderStatus } from './status'
import { logPaymentOrderEvents, type PaymentOrderRow } from './types'
import { executionDateFor } from '@/lib/payments/bank-days'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { dayTakenRefusal, isDayTakenError, skattekontoDayRefusal } from './skattekonto-day'

/** What a person is told when the bank answered a cancel with anything but a confirmation. */
const CANCEL_ANSWER_CODES: Record<Exclude<PaymentCancelOutcome, 'cancelled'>, string> = {
  needs_authorisation: 'PAYMENT_CANCEL_NEEDS_SIGNING',
  too_late: 'PAYMENT_CANCEL_TOO_LATE',
  not_cancelled: 'PAYMENT_CANCEL_NOT_CONFIRMED',
}

/** The signing an order's payment was last offered in, as a refused cancel reads it. */
export interface CancelSigning {
  status: string
  signing_started_at: string | null
  signed_at: string | null
}

/** The order's signing; null without one, or when it cannot be read. */
async function readSigning(ctx: OperationContext, order: PaymentOrderRow): Promise<CancelSigning | null> {
  if (!order.batch_id) return null
  const { data, error } = await ctx.supabase
    .from('payment_order_batches')
    .select('status, signing_started_at, signed_at')
    .eq('company_id', ctx.companyId)
    .eq('id', order.batch_id)
    .maybeSingle()
  if (error || !data) return null
  return data as CancelSigning
}

/**
 * A cancel the bank refused as too late for a payment nobody signed: the bank
 * reports it unsigned (PaymentCancelResult.unsigned) and no signing of it has
 * finished here (submitted, or awaiting_signature in a signing still open).
 * A bank may refuse to cancel such a payment while a BankID for it is open
 * (crm#1282: 405 with RCVD): nothing was paid, and nothing is paid unless
 * someone signs it, so "too late" would be wrong. A signing that finished
 * while the bank still answers RCVD is signed (isBankConfirming), and a
 * refusal then stays too late, as it does when the signing cannot be read.
 */
function refusedWhileUnsigned(order: PaymentOrderRow, answer: PaymentCancelResult, signing: CancelSigning | null): boolean {
  if (answer.outcome !== 'too_late' || answer.unsigned !== true) return false
  if (order.status === 'submitted') return true
  if (order.status !== 'awaiting_signature' || !order.batch_id || !signing) return false
  return !SIGNING_FINISHED_BATCH_STATUSES.has(signing.status)
}

/**
 * Bank statuses that end a payment unpaid: after a cancel the bank did not
 * confirm, an order the bank's own status read puts here follows it at once.
 */
const CLOSED_UNPAID: ReadonlySet<PaymentOrderStatus> = new Set(['cancelled', 'rejected', 'failed'])

/** The payment as the bank reports it now; null when it cannot be read (the status sync reads it again). */
async function readBankState(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  order: PaymentOrderRow,
): Promise<ProviderPaymentState | null> {
  try {
    return await provider.getPaymentState(party, order.provider_payment_id as string, order.provider_payment_product ?? 'domestic')
  } catch (error) {
    ctx.log.warn('payment status read after an unconfirmed cancel failed', {
      orderId: order.id,
      code: error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR',
    })
    return null
  }
}

/**
 * No signature of the order finished here: it never left 'submitted', or its
 * signing is neither finished nor signed. An order whose BankID finished
 * while the bank still answers RCVD (isBankConfirming) is signed.
 */
function noSignatureHere(order: PaymentOrderRow, signing: CancelSigning | null): boolean {
  if (order.signed_at) return false
  if (order.status === 'submitted') return true
  if (order.status !== 'awaiting_signature' || !order.batch_id || !signing) return false
  return !signing.signed_at && !SIGNING_FINISHED_BATCH_STATUSES.has(signing.status)
}

/**
 * How long after the last BankID start an unsigned payment the bank will not
 * cancel may be released here: twice the life of the bank's own signing link
 * (15 minutes) and past the status sync giving up on the signing
 * (ABANDONED_SIGNING_MINUTES), so no BankID of it can still finish.
 */
export const RELEASE_UNSIGNED_AFTER_MINUTES = 30

/**
 * Whether a person may let go here of an order whose payment the bank holds
 * unsigned and refuses to cancel (crm#1282: Danske Bank takes neither a
 * cancel nor a new signing of a started payment through its API, so the
 * payment stays RCVD for good). The bank said so in this very answer (too
 * late, unsigned); the order never got past 'submitted' (an accepted order
 * never comes back to it), has no signature and no create in doubt; its
 * signing is neither open nor finished; and its last BankID started at least
 * RELEASE_UNSIGNED_AFTER_MINUTES ago. No signature, no money: the bank
 * executes nothing unsigned. Never an order that was signed or accepted.
 */
export function isReleasableUnsigned(
  order: Pick<
    PaymentOrderRow,
    'status' | 'provider_payment_id' | 'outcome_unknown_at' | 'create_started_at' | 'signed_at' | 'executed_at' | 'submitted_at' | 'batch_id'
  >,
  signing: CancelSigning | null,
  answer: PaymentCancelResult,
  now: number,
): boolean {
  if (answer.outcome !== 'too_late' || answer.unsigned !== true) return false
  if (order.status !== 'submitted' || !order.provider_payment_id) return false
  if (order.outcome_unknown_at || order.create_started_at || order.signed_at || order.executed_at) return false
  if (order.batch_id) {
    if (!signing || signing.signed_at) return false
    if (signing.status === 'awaiting_signature' || SIGNING_FINISHED_BATCH_STATUSES.has(signing.status)) return false
  }
  const starts = [signing?.signing_started_at, order.submitted_at]
    .filter((at): at is string => Boolean(at))
    .map((at) => Date.parse(at))
    .filter((at) => Number.isFinite(at))
  if (starts.length === 0) return false
  return now - Math.max(...starts) >= RELEASE_UNSIGNED_AFTER_MINUTES * 60_000
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
  const moves: Array<{ order: PaymentOrderRow; to: string }> = []
  for (const o of orders) {
    const to = bankDayFor(o.requested_execution_date, today)
    if (to && to !== o.requested_execution_date) moves.push({ order: o, to })
  }
  // A skattekonto draft moving onto a day that already has an open
  // skattekonto order is refused before anything is written (crm#1485).
  const dayTaken = await skattekontoDayRefusal(writer, ctx.companyId, moves)
  if (dayTaken) return dayTaken
  const movedDates = new Map<string, { from: string; to: string }>()
  for (const { order: o, to } of moves) {
    const { error: moveError } = await writer
      .from('payment_orders')
      .update({ requested_execution_date: to })
      .eq('company_id', ctx.companyId)
      .eq('id', o.id)
      .eq('status', 'draft')
    if (moveError) {
      // Another order took the day after the check above.
      if (o.purpose === 'skattekonto' && isDayTakenError(moveError)) return dayTakenRefusal(o.id, to, null)
      throw moveError
    }
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
 *
 * A payment the bank holds unsigned and refuses to cancel is refused with
 * PAYMENT_CANCEL_UNSIGNED_REFUSED and details.releasable (isReleasableUnsigned).
 * When releasable, the person may ask again with releaseUnsigned: the bank is
 * asked once more, and on the same answer the order is cancelled here (crm#1282).
 * The bank keeps an unsigned payment it never executes; the invoice is free
 * for a new payment. A bank that refuses the cancel with an error instead of
 * an answer says nothing of the payment: it is read once, and the same holds
 * when the bank reports it unsigned (crm#1757).
 */
export async function cancelPaymentOrder(
  ctx: OperationContext,
  input: {
    orderId: string
    signer?: { ipAddress: string | null; userAgent: string | null }
    /** Run the checks and say what a cancel would do (and whether the bank is asked) without writing or asking. */
    dryRun?: boolean
    /** Release here a payment the bank holds unsigned and will not cancel, when isReleasableUnsigned allows it. */
    releaseUnsigned?: boolean
  },
): Promise<OperationOutcome<{ cancelled: boolean; status: string; released_unsigned?: boolean }>> {
  const [order] = await loadOrders(ctx, [input.orderId])
  if (!order) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const writer = createServiceClient()
  const now = new Date().toISOString()

  // release: the detail of an unsigned payment let go here although the bank
  // refused the cancel (isReleasableUnsigned); only while the order is still
  // that payment.
  const markCancelled = async (
    from: string,
    bank: { providerStatus: string | null } | null,
    release?: Record<string, unknown>,
  ) => {
    const providerStatus = bank?.providerStatus ?? null
    const attempt = () => {
      const update = writer
        .from('payment_orders')
        .update({
          status: 'cancelled',
          cancelled_by: ctx.userId,
          cancelled_at: now,
          // Only what the bank said; undefined keys are left out of the request.
          provider_status: providerStatus ?? undefined,
          provider_status_at: providerStatus ? now : undefined,
        })
        .eq('id', order.id)
        .eq('company_id', ctx.companyId)
        .eq('status', from)
      return (release ? update.eq('provider_payment_id', order.provider_payment_id as string) : update).select('id')
    }
    let { data, error } = await attempt()
    // After the bank confirmed the cancel the order must follow: one more try.
    if (error && bank && !release) ({ data, error } = await attempt())
    if (error) {
      if (bank && !release) {
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
          detail: bank ? { provider_payment_id: order.provider_payment_id, ...release } : {},
        },
      ], ctx.log)
    }
    return done
  }

  // A payment the bank holds unsigned and refused to cancel (refusedWhileUnsigned,
  // or a refusal the bank's status read showed unsigned): released here on
  // request when isReleasableUnsigned allows it, otherwise refused with whether
  // it may be. extra: what the bank's refusal said, on the event and the refusal.
  const releaseOrRefuseUnsigned = async (
    signing: CancelSigning | null,
    answer: PaymentCancelResult,
    extra: Record<string, unknown> = {},
  ): Promise<OperationOutcome<{ cancelled: boolean; status: string; released_unsigned?: boolean }>> => {
    const releasable = isReleasableUnsigned(order, signing, answer, Date.now())
    if (releasable && input.releaseUnsigned) {
      const done = await markCancelled(order.status, { providerStatus: answer.providerStatus }, {
        reason: 'UNSIGNED_AT_BANK_NOT_CANCELLABLE',
        released_unsigned: true,
        ...extra,
      })
      if (done) ctx.log.info('unsigned bank payment released here after the bank refused its cancel', { orderId: order.id })
      return { ok: true, data: { cancelled: done, status: done ? 'cancelled' : order.status, released_unsigned: done } }
    }
    return {
      ok: false,
      code: 'PAYMENT_CANCEL_UNSIGNED_REFUSED',
      details: { payment_order_id: order.id, provider_status: answer.providerStatus, releasable, ...extra },
    }
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

  const provider = await getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  if (input.dryRun) {
    // The bank is asked only on the real run: a preview never cancels anything.
    return { ok: true, dryRun: true, preview: { payment_order_id: order.id, status: order.status, at_bank: true, bank_asked: true } }
  }
  // The PSU-ID the payment was created with leads (several banks require it on a cancel).
  const party = await buildPartyContext(ctx, order, { personalNumber: null, ipAddress: input.signer?.ipAddress ?? null, userAgent: input.signer?.userAgent ?? null }, { batchId: order.batch_id, unattended: !input.signer })
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
    // The bank could not be reached, or its answer was lost: nothing more is known now.
    if (failure.code !== 'PAYMENT_PROVIDER_REFUSED') return { ok: false, ...failure }
    // The bank refused the cancel with an error, not an answer (crm#1757: a
    // payment never signed, RCVD at the bank, could never be cancelled, and
    // the person was told the bank did not accept the payment). The error
    // says nothing of the payment, so it is read once, as after a cancel the
    // bank did not confirm: one the bank closed unpaid closes here, and one it
    // holds unsigned with no signature finished here is the unsigned refusal
    // (crm#1282). Anything else stays as it is, never cancelled on our word.
    const providerCode = failure.details.provider_code
    await logPaymentOrderEvents(writer, [
      {
        company_id: ctx.companyId,
        payment_order_id: order.id,
        event_type: 'error',
        from_status: order.status,
        actor_user_id: ctx.userId,
        detail: { code: 'BANK_CANCEL_NOT_CONFIRMED', answer: 'refused', provider_code: providerCode, provider_payment_id: order.provider_payment_id },
      },
    ], ctx.log)
    const state = await readBankState(ctx, provider, party.ctx, order)
    if (state && CLOSED_UNPAID.has(state.status)) {
      const next = await applyProviderState(writer, order, state, ctx.userId, ctx.log)
      if (CLOSED_UNPAID.has(next)) return { ok: true, data: { cancelled: next === 'cancelled', status: next } }
    }
    if (state?.status === 'submitted') {
      // Read after the bank refused, so a signing started meanwhile counts.
      const signing = await readSigning(ctx, order)
      if (noSignatureHere(order, signing)) {
        return releaseOrRefuseUnsigned(
          signing,
          { outcome: 'too_late', providerStatus: state.providerStatus, unsigned: true },
          { provider_code: providerCode },
        )
      }
    }
    return {
      ok: false,
      code: 'PAYMENT_CANCEL_NOT_CONFIRMED',
      details: { payment_order_id: order.id, provider_status: state?.providerStatus ?? null, provider_code: providerCode },
    }
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
    if (answer.outcome === 'needs_authorisation' || answer.outcome === 'not_cancelled') {
      // The payment itself, read once (crm#1699). Every unsigned payment whose
      // cancel a bank did not confirm so far was cancelled or rejected by the
      // bank within minutes (often by the cancel asked a moment earlier), and
      // only the 15-minute status sync picked that up: until then the person
      // was told to look in an online bank that does not show unsigned
      // payments. What the bank reports is applied as the sync applies it
      // (applyProviderState, forward only): the order closes on the bank's
      // word, never on ours.
      const state = await readBankState(ctx, provider, party.ctx, order)
      if (state && CLOSED_UNPAID.has(state.status)) {
        const next = await applyProviderState(writer, order, state, ctx.userId, ctx.log)
        if (CLOSED_UNPAID.has(next)) return { ok: true, data: { cancelled: next === 'cancelled', status: next } }
      }
      // The bank says, in this read, that it holds the payment unsigned (its
      // 'submitted': RCVD or PDNG), and no signature of it finished here:
      // nothing is paid unless someone signs it, and the status sync applies
      // the bank's cancel when it comes.
      if (
        state?.status === 'submitted' &&
        noSignatureHere(order, order.status === 'awaiting_signature' ? await readSigning(ctx, order) : null)
      ) {
        return {
          ok: false,
          code: 'PAYMENT_CANCEL_PENDING_UNSIGNED',
          details: { payment_order_id: order.id, provider_status: state.providerStatus },
        }
      }
    }
    // Read after the bank answered, so a signing started meanwhile counts.
    const signing = answer.outcome === 'too_late' && answer.unsigned === true ? await readSigning(ctx, order) : null
    if (!refusedWhileUnsigned(order, answer, signing)) {
      return { ok: false, code: CANCEL_ANSWER_CODES[answer.outcome], details: { payment_order_id: order.id, provider_status: answer.providerStatus } }
    }
    return releaseOrRefuseUnsigned(signing, answer)
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
    const provider = await getPaymentInitiationProvider(ctx.companyId)
    if (!provider) {
      bankAnswer = 'no_provider'
    } else {
      const party = await buildPartyContext(ctx, order, { personalNumber: null, ipAddress: input.signer?.ipAddress ?? null, userAgent: input.signer?.userAgent ?? null }, { batchId: order.batch_id, unattended: !input.signer })
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
