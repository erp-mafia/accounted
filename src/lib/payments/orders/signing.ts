/**
 * Signing approved payment orders with BankID.
 *
 *   start:   the bank's signing capabilities and the company's verification
 *            are checked before anything changes -> the orders are claimed
 *            (approved -> submitted, one signing batch, one RPC) -> each
 *            payment is created at the bank ONCE: the write-ahead marker
 *            first, then the create, then its id stored at once -> a signing
 *            basket when there are several -> BankID starts and the person
 *            gets the challenge (autostart token or QR data).
 *   poll:    the signer's screen polls; pending returns fresh QR data, an
 *            abandoned signing sends the orders back to 'submitted' (sign
 *            again), a finalised one reads each payment's status.
 *   restart: reads where each payment stands at the bank, then signs what
 *            still waits through rebatch_payment_orders_for_signing, which
 *            re-checks every invoice under lock: the same signing when
 *            nothing dropped out, a new one over the same payments otherwise.
 *            A payment whose earlier BankID the bank let expire cannot be
 *            signed again at Open Payments (a second authorisation answers
 *            FORMAT_ERROR): it is cancelled at the bank, its order claimed
 *            again, and a new payment created under a new idempotency key
 *            (recreateAfterExpiredSigning).
 *
 * What may never happen, and how (the payment_orders migration, rules 1, 2, 5):
 *   - A second payment for one order. Payment APIs may have no idempotency
 *     (Open Payments creates a second payment for a repeated request): the
 *     claim comes first, the marker is written before every create, a create
 *     is never repeated, and a create whose outcome is unknown holds its order
 *     (outcome_unknown_at) instead of failing it, until the bank's debit or a
 *     person resolves it.
 *   - An order going back to approved, or final, while the bank still holds a
 *     payment for it. When a signing cannot go on, the payments already
 *     created are cancelled at the bank first, and only a confirmed cancel
 *     releases an order (release.ts). An order whose cancel is not confirmed
 *     stays submitted with its payment id, for the status poll or a person.
 *   - BankID for an invoice that no longer needs paying: the claim and the
 *     restart re-check the invoices under lock, and BankID starts only after
 *     one more look.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  getPaymentInitiationProvider,
  PaymentProviderError,
  providerWriteOutcome,
  type CreatedPayment,
  type PaymentCancelResult,
  type PaymentInitiationProvider,
  type PaymentInstruction,
  type PaymentPartyContext,
  type ProviderWriteOutcome,
  type SigningChallenge,
  type SigningRedirectReturn,
  type SigningStep,
  type SigningTarget,
} from '@/lib/payments/initiation/provider'
import { openPaymentsDoor } from './switched-on'
import { paymentSigningReturnUrl } from './return-url'
import { normalizeSignerPersonalNumber, rememberSignerPersonalNumber } from '@/lib/auth/bankid-signer'
import { bankDayFor } from './lifecycle'
import type { PaymentOrderEvent } from './types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createServiceClient } from '@/lib/supabase/server'
import { applyProviderState } from './apply-state'
import { buildPartyContext, type SignerInput } from './party'
import { cancelAndRelease, cancelForClosedInvoice, releasePaymentOrder, unpayableOrders } from './release'
import { logPaymentOrderEvents, sanitizedProviderMessage, type PaymentOrderBatchRow, type PaymentOrderRow } from './types'

/** BankID in our screen (same_device, qr) or on the bank's own page (redirect). */
export type SigningMethod = 'same_device' | 'qr' | 'redirect'

/**
 * Where a signing on the bank's own page comes back: the app origin the
 * request came to (the route resolves it to a trusted one). The page is
 * always Betalningar, with the batch named (return-url.ts).
 */
export interface SigningReturnOrigin {
  origin: string
}

const RETURN_ORIGIN_REQUIRED: OperationOutcome<never> = { ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_origin', reason: 'required_for_redirect' } }

export interface SigningView {
  batch_id: string
  status: PaymentOrderBatchRow['status']
  /** Only for the person signing: a QR or autostart token is theirs alone. */
  challenge: SigningChallenge | null
  failure_code: string | null
  /** Which BankID step the bank is at when it signs in several; null when it does not say. */
  step: SigningStep | null
  orders: Array<{ id: string; status: string; provider_status: string | null; outcome_unknown: boolean }>
}

/**
 * Codes after which signing again cannot help: the person lacks the rights
 * or an agreement at the bank, the bank refused for good, or the way out is
 * in the online bank (the provider's documented action). Mirrored in
 * components/payments/payment-order-status.ts.
 */
export const PERMANENT_SIGNING_FAILURES: ReadonlySet<string> = new Set([
  'PSU_RIGHTS_MISSING',
  'PSU_CREDENTIALS_INVALID',
  'PSU_OPEN_BANKING_RIGHTS_MISSING',
  'BANK_AGREEMENT_MISSING',
  'PAYMENT_PRODUCT_AGREEMENT_MISSING',
  'BANKID_NOT_ACTIVATED',
  'BANKID_EXTENDED_USE_REQUIRED',
  'KYC_INVALID',
  'TPP_KYC_INVALID',
  'AMOUNT_LIMITATION_CONTROL_FAILED',
  'SCA_REDIRECT_UNSUPPORTED',
])

const CLAIM_CODES: Record<string, string> = {
  not_found: 'PAYMENT_ORDER_NOT_FOUND',
  not_approved: 'PAYMENT_ORDERS_WRONG_STATUS',
  mixed_accounts: 'PAYMENT_ORDERS_MIXED_ACCOUNTS',
  mixed_currency: 'PAYMENT_ORDERS_MIXED_CURRENCY',
  ineligible: 'PAYMENT_ORDERS_INELIGIBLE',
  invalid_payload: 'VALIDATION_ERROR',
}

const REBATCH_CODES: Record<string, string> = {
  not_found: 'PAYMENT_ORDER_NOT_FOUND',
  not_active: 'PAYMENT_SIGNING_NOT_ACTIVE',
  create_in_progress: 'PAYMENT_ORDER_CREATE_IN_PROGRESS',
  nothing_to_sign: 'PAYMENT_SIGNING_NOTHING_TO_SIGN',
  ineligible: 'PAYMENT_ORDERS_INELIGIBLE',
}

function instructionFor(order: PaymentOrderRow, attempt: number): PaymentInstruction {
  const payee = (() => {
    switch (order.payee_type) {
      case 'bankgiro':
        return { type: 'bankgiro' as const, bankgiro: order.payee_bankgiro ?? '', name: order.payee_name }
      case 'plusgiro':
        return { type: 'plusgiro' as const, plusgiro: order.payee_plusgiro ?? '', name: order.payee_name }
      case 'bank_account':
        return { type: 'bank_account' as const, clearing: order.payee_clearing ?? '', account: order.payee_account ?? '', name: order.payee_name }
      case 'iban':
        return { type: 'iban' as const, iban: order.payee_iban ?? '', bic: order.payee_bic, name: order.payee_name }
    }
  })()
  return {
    endToEndId: order.end_to_end_id,
    attempt,
    amount: Number(order.amount),
    currency: order.currency,
    requestedExecutionDate: order.requested_execution_date,
    debtor: { iban: order.debtor_snapshot.iban ?? null, bban: order.debtor_snapshot.bban ?? null, currency: order.debtor_snapshot.currency },
    payee,
    reference: { type: order.reference_type, value: order.reference },
  }
}

/**
 * Which create of each order this is: one more than the payments the bank
 * confirmed cancelled for it (every confirmed cancel is a provider_cancelled
 * event naming the payment). The number goes into the create's idempotency
 * key, so a replay of the first key never answers a cancelled payment. A
 * read that fails throws: the claim then waits for the stale-claim sweep,
 * which releases a claim whose create never started.
 */
async function createAttempts(writer: SupabaseClient, companyId: string, orders: PaymentOrderRow[]): Promise<Map<string, number>> {
  const { data, error } = await writer
    .from('payment_order_events')
    .select('payment_order_id')
    .eq('company_id', companyId)
    .eq('event_type', 'provider_cancelled')
    .in('payment_order_id', orders.map((o) => o.id))
  if (error) throw error
  const cancelled = new Map<string, number>()
  for (const row of (data ?? []) as Array<{ payment_order_id: string | null }>) {
    if (row.payment_order_id) cancelled.set(row.payment_order_id, (cancelled.get(row.payment_order_id) ?? 0) + 1)
  }
  return new Map(orders.map((o) => [o.id, (cancelled.get(o.id) ?? 0) + 1]))
}

function errorCodeOf(error: unknown): string {
  return error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR'
}

function httpStatusOf(error: unknown): number | null {
  return error instanceof PaymentProviderError ? error.httpStatus : null
}

/** The answer for a call that read or asked the bank and failed: nothing was created by it. */
function readFailure(error: unknown): string {
  return error instanceof PaymentProviderError && (error.retryable || error.outcomeUnknown)
    ? 'PAYMENT_PROVIDER_UNAVAILABLE'
    : 'PAYMENT_PROVIDER_REFUSED'
}

/** The answer for a create that failed, by what the bank may hold. */
function createFailure(outcome: ProviderWriteOutcome): string {
  if (outcome === 'unknown') return 'PAYMENT_ORDERS_OUTCOME_UNKNOWN'
  return outcome === 'not_sent' ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED'
}

function targetOf(batch: PaymentOrderBatchRow, orders: PaymentOrderRow[]): SigningTarget | null {
  if (batch.signing_target === 'basket') {
    return batch.provider_batch_id ? { kind: 'basket', providerBasketId: batch.provider_batch_id } : null
  }
  const [order] = orders
  return order?.provider_payment_id
    ? { kind: 'payment', providerPaymentId: order.provider_payment_id, product: order.provider_payment_product ?? 'domestic' }
    : null
}

/** A payment waiting at the bank, unsigned, in its signing. */
function isWaiting(order: PaymentOrderRow): boolean {
  return order.status === 'submitted' && Boolean(order.provider_payment_id) && !order.outcome_unknown_at
}

/** A claimed order whose create has not ended: on its way to the bank, or never started by a request that died. */
function isCreateUnfinished(order: PaymentOrderRow): boolean {
  return order.status === 'submitted' && !order.provider_payment_id && !order.outcome_unknown_at
}

async function loadBatch(writer: SupabaseClient, companyId: string, batchId: string): Promise<{ batch: PaymentOrderBatchRow; orders: PaymentOrderRow[] } | null> {
  const { data: batch } = await writer
    .from('payment_order_batches')
    .select('*')
    .eq('id', batchId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!batch) return null
  const { data: orders, error } = await writer
    .from('payment_orders')
    .select('*')
    .eq('company_id', companyId)
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return { batch: batch as PaymentOrderBatchRow, orders: (orders ?? []) as PaymentOrderRow[] }
}

function view(
  batch: PaymentOrderBatchRow,
  orders: PaymentOrderRow[],
  challenge: SigningChallenge | null,
  failure: string | null,
  step: SigningStep | null = null,
): SigningView {
  return {
    batch_id: batch.id,
    status: batch.status,
    challenge,
    failure_code: failure,
    step,
    orders: orders.map((o) => ({ id: o.id, status: o.status, provider_status: o.provider_status, outcome_unknown: Boolean(o.outcome_unknown_at) })),
  }
}

/**
 * How this bank will sign, decided up front, before any payment exists: a
 * bank that signs only on its own page signs by redirect whatever was asked
 * (and the party says it prefers that page), a bank that signs only in our
 * screen takes the decoupled method asked for (or QR when its page was
 * asked for), a bank that does neither is refused, and so is a basket it
 * does not take.
 */
type SigningPlan = { ok: true; method: SigningMethod; redirectOnly: boolean } | { ok: false; outcome: OperationOutcome<never> }

async function planSigning(
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  orderCount: number,
  requested: SigningMethod,
): Promise<SigningPlan> {
  let capabilities
  try {
    capabilities = await provider.getBankCapabilities(party)
  } catch (error) {
    return { ok: false, outcome: { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } } }
  }
  if (!capabilities.decoupled && !capabilities.redirect) return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED' } }
  if (orderCount > 1 && !capabilities.basket.supported) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNING_BASKET_UNSUPPORTED', details: { max: 1 } } }
  }
  const max = capabilities.basket.maxPayments
  if (orderCount > 1 && max !== null && orderCount > max) {
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_SIGNING_BASKET_TOO_LARGE', details: { max } } }
  }
  const redirectOnly = !capabilities.decoupled
  const method: SigningMethod = redirectOnly ? 'redirect' : requested === 'redirect' && !capabilities.redirect ? 'qr' : requested
  return { ok: true, method, redirectOnly }
}

/** The plan applied to the party: a bank that signs only on its own page is asked for that page from the first call. */
function planParty(party: PaymentPartyContext, plan: Extract<SigningPlan, { ok: true }>): PaymentPartyContext {
  return plan.redirectOnly ? { ...party, redirectPreferred: true } : party
}

// ---------------------------------------------------------------------------
// One create at the bank: the marker, the call, the answer
// ---------------------------------------------------------------------------

/**
 * The write-ahead marker, before the bank is asked: a create that dies midway
 * is never mistaken for one that was never sent. False when the order moved
 * since the claim; nothing is then sent for it.
 */
async function beginCreate(writer: SupabaseClient, ctx: OperationContext, batchId: string, order: PaymentOrderRow): Promise<boolean> {
  try {
    const { data, error } = await writer
      .from('payment_orders')
      .update({ create_started_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('company_id', ctx.companyId)
      .eq('batch_id', batchId)
      .eq('status', 'submitted')
      .is('provider_payment_id', null)
      .is('outcome_unknown_at', null)
      .is('create_started_at', null)
      .select('id')
    return !error && (data ?? []).length === 1
  } catch {
    return false
  }
}

/**
 * Store the bank's id the moment it exists, ending the create. Tried twice,
 * and an earlier attempt whose answer was lost counts: the order already
 * holds this id.
 */
async function storeProviderPayment(writer: SupabaseClient, ctx: OperationContext, batchId: string, order: PaymentOrderRow, created: CreatedPayment): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await writer
        .from('payment_orders')
        .update({
          provider_payment_id: created.providerPaymentId,
          provider_payment_product: created.product,
          provider_status: created.providerStatus,
          provider_status_at: new Date().toISOString(),
          create_started_at: null,
          // The bank's own id answers an outcome nobody knew (rule 1).
          outcome_unknown_at: null,
        })
        .eq('id', order.id)
        .eq('company_id', ctx.companyId)
        .eq('batch_id', batchId)
        .eq('status', 'submitted')
        .is('provider_payment_id', null)
        .select('id')
      if (!error && (data ?? []).length === 1) return true
    } catch {
      // read back below
    }
    try {
      const { data } = await writer.from('payment_orders').select('provider_payment_id').eq('id', order.id).eq('company_id', ctx.companyId).maybeSingle()
      if ((data as { provider_payment_id: string | null } | null)?.provider_payment_id === created.providerPaymentId) return true
    } catch {
      // tried again
    }
  }
  return false
}

/** The bank refused the instruction itself: nothing exists there, and the same instruction would be refused again. */
async function failOrder(
  writer: SupabaseClient,
  ctx: OperationContext,
  batchId: string,
  order: PaymentOrderRow,
  code: string,
  message: string | null,
): Promise<void> {
  const { data } = await writer
    .from('payment_orders')
    .update({
      status: 'failed',
      create_started_at: null,
      provider_error_code: code,
      provider_error_message: message,
      provider_status_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .eq('company_id', ctx.companyId)
    .eq('batch_id', batchId)
    .eq('status', 'submitted')
    .is('provider_payment_id', null)
    .select('id')
  if ((data ?? []).length === 1) {
    await logPaymentOrderEvents(writer, [
      { company_id: ctx.companyId, payment_order_id: order.id, batch_id: batchId, event_type: 'error', from_status: 'submitted', to_status: 'failed', actor_user_id: ctx.userId, detail: { code } },
    ], ctx.log)
  } else {
    ctx.log.error('bank refused a payment but its order could not be failed', undefined, { orderId: order.id, batchId, code })
  }
}

/** The create may have reached the bank and no id is held: the order stays in payment until resolved. */
async function holdOutcomeUnknown(writer: SupabaseClient, ctx: OperationContext, batchId: string, order: PaymentOrderRow, code: string): Promise<void> {
  const { data } = await writer
    .from('payment_orders')
    .update({ outcome_unknown_at: new Date().toISOString(), create_started_at: null, provider_error_code: code })
    .eq('id', order.id)
    .eq('company_id', ctx.companyId)
    .eq('batch_id', batchId)
    .eq('status', 'submitted')
    .is('provider_payment_id', null)
    .is('outcome_unknown_at', null)
    .select('id')
  if ((data ?? []).length === 1) {
    await logPaymentOrderEvents(writer, [
      { company_id: ctx.companyId, payment_order_id: order.id, batch_id: batchId, event_type: 'outcome_unknown', actor_user_id: ctx.userId, detail: { code, source: 'signing' } },
    ], ctx.log)
  } else {
    // The marker stays; the stale-claim sweep marks the outcome unknown later.
    ctx.log.error('payment create outcome unknown and its order could not be held', undefined, { orderId: order.id, batchId, code })
  }
}

/**
 * A payment the bank created whose id no order holds: cancel it there. True
 * only for a confirmed cancel, recorded on the order it was created for.
 */
async function cancelOrphan(
  writer: SupabaseClient,
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batchId: string,
  order: PaymentOrderRow,
  created: CreatedPayment,
): Promise<boolean> {
  let answer: PaymentCancelResult | null = null
  try {
    answer = await provider.cancelPayment(party, created.providerPaymentId, created.product)
  } catch {
    // reported below
  }
  const confirmed = answer?.outcome === 'cancelled'
  if (confirmed) ctx.log.warn('orphan bank payment cancelled', { orderId: order.id, providerPaymentId: created.providerPaymentId })
  else ctx.log.error('orphan bank payment could not be cancelled', undefined, { orderId: order.id, providerPaymentId: created.providerPaymentId, answer: answer?.outcome ?? 'no_answer' })
  await logPaymentOrderEvents(writer, [
    confirmed
      ? { company_id: ctx.companyId, payment_order_id: order.id, batch_id: batchId, event_type: 'provider_cancelled', provider_status: answer?.providerStatus ?? null, actor_user_id: ctx.userId, detail: { provider_payment_id: created.providerPaymentId, orphan: true } }
      : { company_id: ctx.companyId, payment_order_id: order.id, batch_id: batchId, event_type: 'error', actor_user_id: ctx.userId, detail: { code: 'ORPHAN_CANCEL_NOT_CONFIRMED', provider_payment_id: created.providerPaymentId, answer: answer?.outcome ?? 'no_answer' } },
  ], ctx.log)
  return confirmed
}

/**
 * A signing that cannot go on. Each order is read where it stands now and
 * ends where the bank leaves it: a payment that exists is cancelled there
 * first (cancelAndRelease); a claimed order that was never sent is released.
 * An order with a create in flight, an unknown outcome, or one already
 * handled by the caller is left alone. The signing batch ends as failed.
 */
interface StoppedSigning {
  /** Orders back to approved after the bank confirmed the cancel of their payment, with that payment's id. */
  released: Array<{ order: PaymentOrderRow; providerPaymentId: string }>
  /** Orders whose cancel the bank did not confirm: still submitted with their payment id, for a person. */
  kept: string[]
}

async function stopSigning(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  reason: string,
  handled: ReadonlySet<string> = new Set(),
): Promise<StoppedSigning> {
  const writer = createServiceClient()
  let orders: PaymentOrderRow[] = []
  try {
    orders = (await loadBatch(writer, ctx.companyId, batch.id))?.orders ?? []
  } catch (error) {
    ctx.log.error('stopped signing could not read its orders', error, { batchId: batch.id, reason })
  }
  const actor = { companyId: ctx.companyId, userId: ctx.userId, log: ctx.log }
  const stopped: StoppedSigning = { released: [], kept: [] }
  for (const order of orders) {
    if (handled.has(order.id) || order.create_started_at || order.outcome_unknown_at) continue
    if (order.provider_payment_id && (order.status === 'submitted' || order.status === 'awaiting_signature')) {
      const result = await cancelAndRelease(writer, actor, provider, party, batch.id, order, reason)
      if (result === 'released') stopped.released.push({ order, providerPaymentId: order.provider_payment_id })
      else if (result === 'kept') stopped.kept.push(order.id)
    } else if (!order.provider_payment_id && order.status === 'submitted') {
      await releasePaymentOrder(writer, actor, {
        companyId: ctx.companyId,
        orderId: order.id,
        batchId: batch.id,
        providerPaymentId: null,
        providerStatus: null,
        reason,
      })
    }
  }
  await writer
    .from('payment_order_batches')
    .update({ status: 'failed' })
    .eq('id', batch.id)
    .eq('company_id', ctx.companyId)
    .in('status', ['created', 'awaiting_signature'])
  return stopped
}

// ---------------------------------------------------------------------------
// BankID
// ---------------------------------------------------------------------------

async function beginSca(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  method: SigningMethod,
  ret: SigningReturnOrigin | null,
): Promise<OperationOutcome<SigningView>> {
  // The bank's own page needs a way back: Betalningar on the app origin, the
  // batch named, the batch id as the state the bank echoes.
  if (method === 'redirect' && !ret) return RETURN_ORIGIN_REQUIRED
  const redirect: SigningRedirectReturn | null = method === 'redirect' && ret ? { returnUrl: paymentSigningReturnUrl(ret.origin, batch.id), returnState: batch.id } : null
  const writer = createServiceClient()
  // Every order of this signing must still be waiting at the bank in it: a
  // late answer must never start BankID over an order that moved on.
  const loaded = await loadBatch(writer, ctx.companyId, batch.id)
  const orders = loaded?.orders ?? []
  const waiting = orders.filter(isWaiting)
  if (waiting.length !== batch.order_count || waiting.length !== orders.length) return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  const current = loaded?.batch ?? batch
  const target = targetOf(current, waiting)
  if (!target) return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  // One more look right before BankID: an invoice paid another way since the
  // claim leaves its payment waiting, unsigned, for the status sync to cancel.
  const unpayable = await unpayableOrders(writer, waiting)
  if (unpayable.size > 0) return { ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE', details: { orders: [...unpayable] } }

  let started
  try {
    started = await provider.startSigning(party, target, method, redirect)
  } catch (error) {
    const code = errorCodeOf(error)
    ctx.log.warn('payment signing did not start', { batchId: batch.id, code })
    if (error instanceof PaymentProviderError && error.outcomeUnknown) {
      // A BankID request may already be on the person's phone: nothing is
      // undone, and the status poll reads what the bank decides.
      return { ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { provider_code: code, outcome_unknown: true } }
    }
    const permanent = PERMANENT_SIGNING_FAILURES.has(code)
    if (permanent) {
      // Signing again cannot help: the payments are cancelled at the bank and
      // the orders go back to approved, to be paid another way or by another signer.
      await stopSigning(ctx, provider, party, current, code)
    }
    const answer = code === 'SCA_REDIRECT_UNSUPPORTED' ? 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED' : readFailure(error)
    // signing_start_refused: the bank refused to start, nothing else moved (restart reads it to decide on a recreate).
    return { ok: false, code: answer, details: { provider_code: code, http_status: httpStatusOf(error), signing_start_refused: !permanent && !(error instanceof PaymentProviderError && error.retryable) } }
  }

  const now = new Date().toISOString()
  let claimSigning = writer
    .from('payment_order_batches')
    .update({
      status: 'awaiting_signature',
      provider_authorisation_id: started.providerAuthorisationId,
      signing_method: started.method,
      signer_user_id: ctx.userId,
      signing_started_at: now,
    })
    .eq('id', batch.id)
    .eq('company_id', ctx.companyId)
    .eq('status', current.status)
  claimSigning = current.provider_authorisation_id
    ? claimSigning.eq('provider_authorisation_id', current.provider_authorisation_id)
    : claimSigning.is('provider_authorisation_id', null)
  const { data: updated } = await claimSigning.select('*').maybeSingle()
  if (!updated) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' }
  await writer
    .from('payment_orders')
    .update({ status: 'awaiting_signature' })
    .eq('company_id', ctx.companyId)
    .eq('batch_id', batch.id)
    .eq('status', 'submitted')
  await logPaymentOrderEvents(writer, [
    { company_id: ctx.companyId, batch_id: batch.id, event_type: 'signing_started', actor_user_id: ctx.userId, detail: { method: started.method } },
  ], ctx.log)
  const refreshed = await loadBatch(writer, ctx.companyId, batch.id)
  return { ok: true, data: view(updated as PaymentOrderBatchRow, refreshed?.orders ?? waiting, started.challenge, null, started.step) }
}

/** A basket over the payments of a signing, stored once. */
async function createBasket(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  orders: PaymentOrderRow[],
): Promise<{ ok: true; batch: PaymentOrderBatchRow } | { ok: false; outcome: OperationOutcome<never> }> {
  const writer = createServiceClient()
  let basket
  try {
    basket = await provider.createSigningBasket(
      party,
      orders.map((o) => o.provider_payment_id as string),
    )
  } catch (error) {
    // A basket nobody signs is harmless; the payments in it are cancelled.
    await stopSigning(ctx, provider, party, batch, `BASKET_${errorCodeOf(error)}`)
    return { ok: false, outcome: { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } } }
  }
  const { data: withBasket } = await writer
    .from('payment_order_batches')
    .update({ provider_batch_id: basket.providerBasketId })
    .eq('id', batch.id)
    .eq('company_id', ctx.companyId)
    .eq('status', 'created')
    .is('provider_batch_id', null)
    .select('*')
    .maybeSingle()
  if (!withBasket) {
    ctx.log.error('signing basket created at the bank but not stored', undefined, { batchId: batch.id, providerBasketId: basket.providerBasketId })
    await stopSigning(ctx, provider, party, batch, 'BASKET_NOT_STORED')
    return { ok: false, outcome: { ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE' } }
  }
  return { ok: true, batch: withBasket as PaymentOrderBatchRow }
}

/**
 * An approved order whose day the bank cannot pay on (prepared before a
 * weekend, or long ago) is re-attested by the signer with the next banking
 * day: back to draft, the date, approved again, each step on the record. The
 * instruction is immutable past draft, so this is the one honest way to move
 * it; the person signing is the one attesting.
 */
async function reattestWithBankDay(ctx: OperationContext, orders: PaymentOrderRow[], today: string): Promise<OperationOutcome<null>> {
  const writer = createServiceClient()
  for (const order of orders) {
    const to = bankDayFor(order.requested_execution_date, today)
    if (!to || to === order.requested_execution_date) continue
    const from = order.requested_execution_date
    const now = new Date().toISOString()
    const { data: back, error: backError } = await writer
      .from('payment_orders')
      .update({ status: 'draft', approved_by: null, approved_at: null })
      .eq('company_id', ctx.companyId)
      .eq('id', order.id)
      .eq('status', 'approved')
      .select('id')
    if (backError) throw backError
    if ((back ?? []).length !== 1) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { payment_order_id: order.id } }
    const { error: dateError } = await writer.from('payment_orders').update({ requested_execution_date: to }).eq('company_id', ctx.companyId).eq('id', order.id).eq('status', 'draft')
    if (dateError) throw dateError
    const { data: again, error: againError } = await writer
      .from('payment_orders')
      .update({ status: 'approved', approved_by: ctx.userId, approved_at: now })
      .eq('company_id', ctx.companyId)
      .eq('id', order.id)
      .eq('status', 'draft')
      .select('id')
    if (againError) throw againError
    const trail: PaymentOrderEvent[] = [
      { company_id: ctx.companyId, payment_order_id: order.id, event_type: 'unapproved', from_status: 'approved', to_status: 'draft', actor_user_id: ctx.userId, detail: { reason: 'date_moved', from, to } },
    ]
    if ((again ?? []).length === 1) {
      trail.push({ company_id: ctx.companyId, payment_order_id: order.id, event_type: 'approved', from_status: 'draft', to_status: 'approved', actor_user_id: ctx.userId, detail: { date_moved_from: from, date_moved_to: to } })
    }
    await logPaymentOrderEvents(writer, trail, ctx.log)
    if ((again ?? []).length !== 1) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS', details: { payment_order_id: order.id, date_moved_to: to } }
    order.requested_execution_date = to
  }
  return { ok: true, data: null }
}

/**
 * Every payment of a claimed signing created at the bank once (the marker,
 * the create, the id stored), a basket over them when there are several, and
 * BankID started. Shared by the first signing and a recreate after an
 * expired one.
 */
async function sendAndSign(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  claimed: { batch: PaymentOrderBatchRow; orders: PaymentOrderRow[] },
  method: SigningMethod,
  ret: SigningReturnOrigin | null,
): Promise<OperationOutcome<SigningView>> {
  const writer = createServiceClient()
  let batch = claimed.batch
  const orders = claimed.orders
  const attempts = await createAttempts(writer, ctx.companyId, orders)
  for (const order of orders) {
    if (!(await beginCreate(writer, ctx, batch.id, order))) {
      // The order moved since the claim (the stale-claim sweep let it go):
      // nothing is sent for it, and the payments already created are cancelled.
      ctx.log.warn('payment order moved before its create', { orderId: order.id, batchId: batch.id })
      await stopSigning(ctx, provider, party, batch, 'ORDER_MOVED')
      return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE', details: { payment_order_id: order.id } }
    }
    let created: CreatedPayment
    try {
      created = await provider.createPayment(party, instructionFor(order, attempts.get(order.id) ?? 1))
    } catch (error) {
      const outcome = providerWriteOutcome(error)
      const code = errorCodeOf(error)
      ctx.log.warn('payment creation at the bank failed', { orderId: order.id, code, outcome })
      if (outcome === 'unknown') await holdOutcomeUnknown(writer, ctx, batch.id, order, code)
      else if (outcome === 'refused') await failOrder(writer, ctx, batch.id, order, code, sanitizedProviderMessage(error))
      else {
        await releasePaymentOrder(writer, ctx, {
          companyId: ctx.companyId,
          orderId: order.id,
          batchId: batch.id,
          providerPaymentId: null,
          providerStatus: null,
          reason: 'CREATE_NOT_SENT',
          errorCode: code,
        })
      }
      await stopSigning(ctx, provider, party, batch, 'SIGNING_STOPPED', new Set([order.id]))
      return { ok: false, code: createFailure(outcome), details: { provider_code: code, payment_order_id: order.id } }
    }
    if (!(await storeProviderPayment(writer, ctx, batch.id, order, created))) {
      ctx.log.error('bank payment created but its id could not be stored', undefined, {
        orderId: order.id,
        batchId: batch.id,
        providerPaymentId: created.providerPaymentId,
      })
      const orphanCancelled = await cancelOrphan(writer, ctx, provider, party, batch.id, order, created)
      const released = orphanCancelled
        ? await releasePaymentOrder(writer, ctx, {
            companyId: ctx.companyId,
            orderId: order.id,
            batchId: batch.id,
            providerPaymentId: null,
            providerStatus: null,
            reason: 'PROVIDER_ID_NOT_STORED',
            errorCode: 'PROVIDER_ID_NOT_STORED',
          })
        : null
      if (released !== 'approved' && released !== 'cancelled') await holdOutcomeUnknown(writer, ctx, batch.id, order, 'PROVIDER_ID_NOT_STORED')
      await stopSigning(ctx, provider, party, batch, 'SIGNING_STOPPED', new Set([order.id]))
      return released === 'approved' || released === 'cancelled'
        ? { ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { payment_order_id: order.id } }
        : { ok: false, code: 'PAYMENT_ORDERS_OUTCOME_UNKNOWN', details: { payment_order_id: order.id } }
    }
    order.provider_payment_id = created.providerPaymentId
    order.provider_payment_product = created.product
    order.provider_status = created.providerStatus
  }

  if (batch.signing_target === 'basket') {
    const withBasket = await createBasket(ctx, provider, party, batch, orders)
    if (!withBasket.ok) return withBasket.outcome
    batch = withBasket.batch
  }

  return beginSca(ctx, provider, party, batch, method, ret)
}

export async function startPaymentSigning(
  ctx: OperationContext,
  input: { orderIds: string[]; method: SigningMethod; signer: SignerInput; returnOrigin?: string | null; today?: string },
): Promise<OperationOutcome<SigningView>> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const door = await openPaymentsDoor(ctx)
  if (!door.ok) return { ok: false, code: 'PAYMENTS_UNAVAILABLE', details: { reason: door.reason } }
  const provider = door.provider

  const { data: preview, error: previewError } = await ctx.supabase
    .from('payment_orders')
    .select('*')
    .eq('company_id', ctx.companyId)
    .in('id', ids)
  if (previewError) throw previewError
  const previewOrders = (preview ?? []) as PaymentOrderRow[]
  if (previewOrders.length !== ids.length) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  if (previewOrders.some((o) => o.status !== 'approved')) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' }
  if (new Set(previewOrders.map((o) => o.cash_account_id)).size > 1) return { ok: false, code: 'PAYMENT_ORDERS_MIXED_ACCOUNTS' }
  if (new Set(previewOrders.map((o) => o.currency)).size > 1) return { ok: false, code: 'PAYMENT_ORDERS_MIXED_CURRENCY' }
  const reattested = await reattestWithBankDay(ctx, previewOrders, input.today ?? todayIsoStockholm())
  if (!reattested.ok) return reattested

  const built = await buildPartyContext(ctx, previewOrders[0]!, input.signer, { requireSigner: true })
  if (!built.ok) return built.outcome

  // Before anything is claimed: how this bank signs (or that it cannot), and
  // a company the provider has not verified (every payment would be refused,
  // TPP_KYC_INVALID). The verification is the company's, so it is asked for
  // in the corporate context only; whether a private-context payment (an
  // enskild firma on the owner's agreement) needs one is the provider's open
  // question (DECISIONS.md 2026-10-12), and until it is answered such a
  // payment is tried, and the bank's own TPP_KYC_INVALID is shown if it comes.
  const plan = await planSigning(provider, built.ctx, ids.length, input.method)
  if (!plan.ok) return plan.outcome
  const ret: SigningReturnOrigin | null = input.returnOrigin ? { origin: input.returnOrigin } : null
  if (plan.method === 'redirect' && !ret) return RETURN_ORIGIN_REQUIRED
  const party = { ...built, ctx: planParty(built.ctx, plan) }
  if (party.ctx.accountContext === 'corporate') {
    try {
      const verification = await provider.getCompanyVerification(party.ctx)
      if (verification.status !== 'valid') return { ok: false, code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED' }
    } catch (error) {
      return { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } }
    }
  }

  // The claim runs as the service role: only server code may move orders
  // towards a bank, after this route authenticated the person.
  const writer = createServiceClient()
  const { data: claim, error: claimError } = await writer.rpc('claim_payment_orders_for_signing', {
    p_company_id: ctx.companyId,
    p_order_ids: ids,
    p_provider: provider.id,
    p_user_id: ctx.userId,
  })
  if (claimError) throw claimError
  const claimed = claim as { ok: boolean; code?: string; details?: unknown; batch?: PaymentOrderBatchRow; orders?: PaymentOrderRow[] }
  if (!claimed.ok || !claimed.batch || !claimed.orders) {
    return {
      ok: false,
      code: CLAIM_CODES[claimed.code ?? ''] ?? 'PAYMENT_ORDERS_WRONG_STATUS',
      details: { claim_code: claimed.code, claim_details: claimed.details as Record<string, unknown> | undefined },
    }
  }

  const started = await sendAndSign(ctx, provider, party.ctx, { batch: claimed.batch, orders: claimed.orders }, plan.method, ret)
  if (started.ok) await rememberTypedSigner(ctx, input.signer)
  return started
}

/**
 * A number the person typed is remembered once the bank accepted a signing
 * start with it, so the next payment asks for nothing. Best effort: a failed
 * write costs one more typing, never the signing.
 */
async function rememberTypedSigner(ctx: OperationContext, signer: SignerInput): Promise<void> {
  const typed = normalizeSignerPersonalNumber(signer.personalNumber)
  if (!typed) return
  try {
    await rememberSignerPersonalNumber(ctx.userId, typed)
  } catch (error) {
    ctx.log.warn('could not remember the signer', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Start BankID again. Each payment still waiting is read at the bank first:
 * one the bank reports cancelled lets its order go (a status read showing
 * the cancel confirms it), one the bank moved on (signed, executed, refused)
 * moves its order on, and one whose invoice no longer needs paying is
 * cancelled at the bank; a status that cannot be read stops the restart.
 * What still waits is signed through rebatch_payment_orders_for_signing,
 * which re-checks every invoice under lock: the same signing when nothing
 * dropped out, otherwise a new one over the same payments, never new ones.
 */
export async function restartPaymentSigning(
  ctx: OperationContext,
  input: { batchId: string; method: SigningMethod; signer: SignerInput; returnOrigin?: string | null },
): Promise<OperationOutcome<SigningView>> {
  const provider = await getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  const writer = createServiceClient()
  const loaded = await loadBatch(writer, ctx.companyId, input.batchId)
  if (!loaded) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const { batch, orders } = loaded
  if (batch.status !== 'created' && batch.status !== 'failed') return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  // A create of this signing has not ended: nothing is signed until it has.
  if (orders.some(isCreateUnfinished)) return { ok: false, code: 'PAYMENT_ORDER_CREATE_IN_PROGRESS' }
  const waiting = orders.filter(isWaiting)
  if (waiting.length === 0) return { ok: false, code: 'PAYMENT_SIGNING_NOTHING_TO_SIGN' }

  const built = await buildPartyContext(ctx, waiting[0]!, input.signer, { requireSigner: true })
  if (!built.ok) return built.outcome
  // The plan first: the bank's own page needs the origin to come back to
  // before anything is read or moved.
  let plan = await planSigning(provider, built.ctx, waiting.length, input.method)
  if (!plan.ok) return plan.outcome
  const ret: SigningReturnOrigin | null = input.returnOrigin ? { origin: input.returnOrigin } : null
  if (plan.method === 'redirect' && !ret) return RETURN_ORIGIN_REQUIRED
  const party = { ...built, ctx: planParty(built.ctx, plan) }

  const unpayable = await unpayableOrders(writer, waiting)
  for (const order of waiting) {
    let state
    try {
      state = await provider.getPaymentState(party.ctx, order.provider_payment_id as string, order.provider_payment_product ?? 'domestic')
    } catch (error) {
      // Not knowing where a payment stands holds the whole signing.
      return { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error), payment_order_id: order.id } }
    }
    if (state.status === 'cancelled') {
      await releasePaymentOrder(writer, ctx, {
        companyId: ctx.companyId,
        orderId: order.id,
        batchId: batch.id,
        providerPaymentId: order.provider_payment_id,
        providerStatus: state.providerStatus,
        reason: 'BANK_REPORTS_CANCELLED',
      })
    } else if (state.status !== 'submitted' && state.status !== 'awaiting_signature') {
      await applyProviderState(writer, order, state, ctx.userId, ctx.log)
    } else if (unpayable.has(order.id)) {
      await cancelForClosedInvoice(writer, ctx, provider, party.ctx, order)
    }
  }

  const still = ((await loadBatch(writer, ctx.companyId, batch.id))?.orders ?? []).filter(isWaiting)
  if (still.length === 0) return { ok: false, code: 'PAYMENT_SIGNING_NOTHING_TO_SIGN' }
  if (still.length !== waiting.length) {
    // Fewer payments than planned for: the basket rules are checked again for what is left.
    plan = await planSigning(provider, party.ctx, still.length, input.method)
    if (!plan.ok) return plan.outcome
  }
  const { data: rebatch, error } = await writer.rpc('rebatch_payment_orders_for_signing', {
    p_company_id: ctx.companyId,
    p_batch_id: batch.id,
    p_user_id: ctx.userId,
  })
  if (error) throw error
  const moved = rebatch as { ok: boolean; same?: boolean; code?: string; details?: unknown; batch?: PaymentOrderBatchRow; orders?: PaymentOrderRow[] }
  if (!moved.ok || !moved.batch || !moved.orders) {
    return {
      ok: false,
      code: REBATCH_CODES[moved.code ?? ''] ?? 'PAYMENT_SIGNING_NOT_ACTIVE',
      details: { rebatch_code: moved.code, rebatch_details: moved.details as Record<string, unknown> | undefined },
    }
  }
  let next = moved.batch
  if (!moved.same && next.signing_target === 'basket') {
    const withBasket = await createBasket(ctx, provider, party.ctx, next, moved.orders)
    if (!withBasket.ok) return withBasket.outcome
    next = withBasket.batch
  }
  const started = await beginSca(ctx, provider, party.ctx, next, plan.method, ret)
  // The payments had an authorisation before (this signing started once) and
  // the bank refuses to start another on them: they are recreated.
  if (started.ok || !batch.provider_authorisation_id || !isStaleAuthorisationRefusal(started)) return started
  return recreateAfterExpiredSigning(ctx, provider, party.ctx, next, plan.method, ret, started)
}

/**
 * A signing start the bank refused outright (FORMAT_ERROR, or any 400) on
 * payments that already had an authorisation: Open Payments does not start a
 * second authorisation on a payment whose first one expired or was cancelled.
 * Not a retryable failure, not one signing can never fix (those cancelled the
 * payments already), not an unknown outcome.
 */
function isStaleAuthorisationRefusal(outcome: OperationOutcome<SigningView>): boolean {
  if (outcome.ok) return false
  const details = outcome.details ?? {}
  if (details.signing_start_refused !== true) return false
  const code = typeof details.provider_code === 'string' ? details.provider_code : ''
  return code === 'FORMAT_ERROR' || details.http_status === 400
}

/**
 * Sign again after the bank let a BankID expire: a new authorisation on the
 * same payment is refused, so each payment still waiting is cancelled at the
 * bank and its order released (a confirmed cancel only, as everywhere), the
 * released orders are claimed again under a new signing, and new payments
 * are created for them under new idempotency keys (createAttempts) and
 * signed. A cancel the bank does not confirm holds its order for a person,
 * as today; nothing is then recreated, and the person sees the refusal. The
 * recreate is on the record: one event per order in the new signing, naming
 * the previous signing and payment.
 */
async function recreateAfterExpiredSigning(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  expired: PaymentOrderBatchRow,
  method: SigningMethod,
  ret: SigningReturnOrigin | null,
  refusal: OperationOutcome<SigningView>,
): Promise<OperationOutcome<SigningView>> {
  const providerCode = !refusal.ok ? refusal.details?.provider_code : null
  ctx.log.warn('bank refused a new authorisation on signed-before payments; recreating them', { batchId: expired.id, code: providerCode })
  const stopped = await stopSigning(ctx, provider, party, expired, 'SIGNING_EXPIRED')
  if (stopped.kept.length > 0 || stopped.released.length === 0) {
    // The bank did not confirm every cancel: those orders wait for a person, nothing new is made.
    return refusal.ok ? refusal : { ...refusal, details: { ...(refusal.details ?? {}), held_for_person: stopped.kept, recreated: false } }
  }

  const writer = createServiceClient()
  const { data: claim, error: claimError } = await writer.rpc('claim_payment_orders_for_signing', {
    p_company_id: ctx.companyId,
    p_order_ids: stopped.released.map((r) => r.order.id),
    p_provider: provider.id,
    p_user_id: ctx.userId,
  })
  if (claimError) throw claimError
  const claimed = claim as { ok: boolean; code?: string; details?: unknown; batch?: PaymentOrderBatchRow; orders?: PaymentOrderRow[] }
  if (!claimed.ok || !claimed.batch || !claimed.orders) {
    return {
      ok: false,
      code: CLAIM_CODES[claimed.code ?? ''] ?? 'PAYMENT_ORDERS_WRONG_STATUS',
      details: { claim_code: claimed.code, claim_details: claimed.details as Record<string, unknown> | undefined, recreated: false },
    }
  }
  const previous = new Map(stopped.released.map((r) => [r.order.id, r.providerPaymentId]))
  await logPaymentOrderEvents(
    writer,
    claimed.orders.map((order) => ({
      company_id: ctx.companyId,
      payment_order_id: order.id,
      batch_id: claimed.batch!.id,
      event_type: 'recreated_after_expired_signing' as const,
      from_status: 'approved',
      to_status: 'submitted',
      actor_user_id: ctx.userId,
      detail: { previous_batch_id: expired.id, previous_provider_payment_id: previous.get(order.id) ?? null, provider_code: providerCode ?? null },
    })),
    ctx.log,
  )
  return sendAndSign(ctx, provider, party, { batch: claimed.batch, orders: claimed.orders }, method, ret)
}

export async function pollPaymentSigning(
  ctx: OperationContext,
  input: { batchId: string; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const provider = await getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  const writer = createServiceClient()
  const loaded = await loadBatch(writer, ctx.companyId, input.batchId)
  if (!loaded) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const { batch, orders } = loaded
  // The QR code and the autostart token belong to the person signing; anyone
  // else sees where the signing stands, and does not drive it.
  if (batch.signer_user_id && batch.signer_user_id !== ctx.userId) {
    return { ok: true, data: view(batch, orders, null, null) }
  }
  if (batch.status !== 'awaiting_signature' || !batch.provider_authorisation_id) {
    return { ok: true, data: view(batch, orders, null, null) }
  }
  const target = targetOf(batch, orders)
  if (!target) return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  const party = await buildPartyContext(ctx, orders[0]!, input.signer)
  if (!party.ok) return party.outcome

  let progress
  try {
    progress = await provider.pollSigning(party.ctx, target, batch.provider_authorisation_id, batch.signing_method ?? 'qr')
  } catch (error) {
    return { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } }
  }
  if (progress.state === 'pending') return { ok: true, data: view(batch, orders, progress.challenge, null, progress.step) }

  if (progress.state === 'failed') {
    const code = progress.failureCode ?? 'SCA_FAILED'
    if (PERMANENT_SIGNING_FAILURES.has(code)) {
      await stopSigning(ctx, provider, party.ctx, batch, code)
    } else {
      // Abandoned, cancelled or timed out: the payments still wait at the bank
      // and can be signed again. Only this attempt is reset, never a newer one.
      const { data: reset } = await writer
        .from('payment_order_batches')
        .update({ status: 'created' })
        .eq('id', batch.id)
        .eq('company_id', ctx.companyId)
        .eq('status', 'awaiting_signature')
        .eq('provider_authorisation_id', batch.provider_authorisation_id)
        .select('id')
      if ((reset ?? []).length === 1) {
        await writer.from('payment_orders').update({ status: 'submitted' }).eq('company_id', ctx.companyId).eq('batch_id', batch.id).eq('status', 'awaiting_signature')
        await logPaymentOrderEvents(writer, [
          { company_id: ctx.companyId, batch_id: batch.id, event_type: 'error', actor_user_id: ctx.userId, detail: { code, stage: 'signing' } },
        ], ctx.log)
      }
    }
    const after = await loadBatch(writer, ctx.companyId, batch.id)
    return { ok: true, data: view(after?.batch ?? batch, after?.orders ?? orders, null, code) }
  }

  // Finalised. The signing, not the payment status, says it succeeded; now
  // read where each payment stands (a second signer, accepted, executed).
  const statuses: string[] = []
  for (const order of orders) {
    if (!order.provider_payment_id) continue
    try {
      const state = await provider.getPaymentState(party.ctx, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
      statuses.push(await applyProviderState(writer, order, state, ctx.userId, ctx.log))
    } catch (error) {
      ctx.log.warn('payment status after signing could not be read', { orderId: order.id, code: errorCodeOf(error) })
      statuses.push(order.status)
    }
  }
  const batchStatus = statuses.some((s) => s === 'awaiting_second_signer')
    ? 'awaiting_second_signer'
    : statuses.length > 0 && statuses.every((s) => s === 'rejected')
      ? 'rejected'
      : 'signed'
  await writer
    .from('payment_order_batches')
    .update({ status: batchStatus, signed_at: new Date().toISOString() })
    .eq('id', batch.id)
    .eq('company_id', ctx.companyId)
    .eq('status', 'awaiting_signature')
    .eq('provider_authorisation_id', batch.provider_authorisation_id)
  const after = await loadBatch(writer, ctx.companyId, batch.id)
  return { ok: true, data: view(after?.batch ?? batch, after?.orders ?? orders, null, null) }
}
