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
  type SigningTarget,
} from '@/lib/payments/initiation/provider'
import { openPaymentsDoor } from './switched-on'
import { createServiceClient } from '@/lib/supabase/server'
import { applyProviderState } from './apply-state'
import { buildPartyContext, type SignerInput } from './party'
import { cancelAndRelease, cancelForClosedInvoice, releasePaymentOrder, unpayableOrders } from './release'
import { logPaymentOrderEvents, sanitizedProviderMessage, type PaymentOrderBatchRow, type PaymentOrderRow } from './types'

export type SigningMethod = 'same_device' | 'qr'

export interface SigningView {
  batch_id: string
  status: PaymentOrderBatchRow['status']
  /** Only for the person signing: a QR or autostart token is theirs alone. */
  challenge: SigningChallenge | null
  failure_code: string | null
  orders: Array<{ id: string; status: string; provider_status: string | null; outcome_unknown: boolean }>
}

/**
 * Codes after which signing again cannot help: the person lacks the rights,
 * the bank refused for good, or the bank only signs on its own page. Signing
 * on the bank's page (the redirect approach) is not supported yet: it needs
 * the connection callback that milestone 1 adds with the Connect adapter.
 */
const PERMANENT_SIGNING_FAILURES = new Set(['PSU_RIGHTS_MISSING', 'BANKID_NOT_ACTIVATED', 'TPP_KYC_INVALID', 'SCA_REDIRECT_UNSUPPORTED'])

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

function instructionFor(order: PaymentOrderRow): PaymentInstruction {
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
    amount: Number(order.amount),
    currency: order.currency,
    requestedExecutionDate: order.requested_execution_date,
    debtor: { iban: order.debtor_snapshot.iban ?? null, bban: order.debtor_snapshot.bban ?? null, currency: order.debtor_snapshot.currency },
    payee,
    reference: { type: order.reference_type, value: order.reference },
  }
}

function errorCodeOf(error: unknown): string {
  return error instanceof PaymentProviderError ? error.code : 'UNEXPECTED_ERROR'
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

function view(batch: PaymentOrderBatchRow, orders: PaymentOrderRow[], challenge: SigningChallenge | null, failure: string | null): SigningView {
  return {
    batch_id: batch.id,
    status: batch.status,
    challenge,
    failure_code: failure,
    orders: orders.map((o) => ({ id: o.id, status: o.status, provider_status: o.provider_status, outcome_unknown: Boolean(o.outcome_unknown_at) })),
  }
}

/**
 * Refuse up front what this bank cannot sign, before any payment exists: a
 * bank that signs only on its own page, or a basket it does not take.
 */
async function checkSigningCapabilities(
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  orderCount: number,
): Promise<OperationOutcome<never> | null> {
  let capabilities
  try {
    capabilities = await provider.getBankCapabilities(party)
  } catch (error) {
    return { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } }
  }
  if (!capabilities.decoupled) return { ok: false, code: 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED' }
  if (orderCount > 1 && !capabilities.basket.supported) {
    return { ok: false, code: 'PAYMENT_SIGNING_BASKET_UNSUPPORTED', details: { max: 1 } }
  }
  const max = capabilities.basket.maxPayments
  if (orderCount > 1 && max !== null && orderCount > max) {
    return { ok: false, code: 'PAYMENT_SIGNING_BASKET_TOO_LARGE', details: { max } }
  }
  return null
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
async function stopSigning(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  reason: string,
  handled: ReadonlySet<string> = new Set(),
): Promise<void> {
  const writer = createServiceClient()
  let orders: PaymentOrderRow[] = []
  try {
    orders = (await loadBatch(writer, ctx.companyId, batch.id))?.orders ?? []
  } catch (error) {
    ctx.log.error('stopped signing could not read its orders', error, { batchId: batch.id, reason })
  }
  const actor = { companyId: ctx.companyId, userId: ctx.userId, log: ctx.log }
  for (const order of orders) {
    if (handled.has(order.id) || order.create_started_at || order.outcome_unknown_at) continue
    if (order.provider_payment_id && (order.status === 'submitted' || order.status === 'awaiting_signature')) {
      await cancelAndRelease(writer, actor, provider, party, batch.id, order, reason)
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
): Promise<OperationOutcome<SigningView>> {
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
    started = await provider.startSigning(party, target, method)
  } catch (error) {
    const code = errorCodeOf(error)
    ctx.log.warn('payment signing did not start', { batchId: batch.id, code })
    if (error instanceof PaymentProviderError && error.outcomeUnknown) {
      // A BankID request may already be on the person's phone: nothing is
      // undone, and the status poll reads what the bank decides.
      return { ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { provider_code: code, outcome_unknown: true } }
    }
    if (PERMANENT_SIGNING_FAILURES.has(code)) {
      // Signing again cannot help: the payments are cancelled at the bank and
      // the orders go back to approved, to be paid another way or by another signer.
      await stopSigning(ctx, provider, party, current, code)
    }
    const answer = code === 'SCA_REDIRECT_UNSUPPORTED' ? 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED' : readFailure(error)
    return { ok: false, code: answer, details: { provider_code: code } }
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
  return { ok: true, data: view(updated as PaymentOrderBatchRow, refreshed?.orders ?? waiting, started.challenge, null) }
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

export async function startPaymentSigning(
  ctx: OperationContext,
  input: { orderIds: string[]; method: SigningMethod; signer: SignerInput },
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

  const party = await buildPartyContext(ctx, previewOrders[0]!, input.signer, { requireSigner: true })
  if (!party.ok) return party.outcome

  // Before anything is claimed: what this bank cannot sign, and a company the
  // provider has not verified (every payment would be refused, TPP_KYC_INVALID).
  const refusal = await checkSigningCapabilities(provider, party.ctx, ids.length)
  if (refusal) return refusal
  try {
    const verification = await provider.getCompanyVerification(party.ctx)
    if (verification.status !== 'valid') return { ok: false, code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED' }
  } catch (error) {
    return { ok: false, code: readFailure(error), details: { provider_code: errorCodeOf(error) } }
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

  let batch = claimed.batch
  const orders = claimed.orders
  for (const order of orders) {
    if (!(await beginCreate(writer, ctx, batch.id, order))) {
      // The order moved since the claim (the stale-claim sweep let it go):
      // nothing is sent for it, and the payments already created are cancelled.
      ctx.log.warn('payment order moved before its create', { orderId: order.id, batchId: batch.id })
      await stopSigning(ctx, provider, party.ctx, batch, 'ORDER_MOVED')
      return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE', details: { payment_order_id: order.id } }
    }
    let created: CreatedPayment
    try {
      created = await provider.createPayment(party.ctx, instructionFor(order))
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
      await stopSigning(ctx, provider, party.ctx, batch, 'SIGNING_STOPPED', new Set([order.id]))
      return { ok: false, code: createFailure(outcome), details: { provider_code: code, payment_order_id: order.id } }
    }
    if (!(await storeProviderPayment(writer, ctx, batch.id, order, created))) {
      ctx.log.error('bank payment created but its id could not be stored', undefined, {
        orderId: order.id,
        batchId: batch.id,
        providerPaymentId: created.providerPaymentId,
      })
      const orphanCancelled = await cancelOrphan(writer, ctx, provider, party.ctx, batch.id, order, created)
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
      await stopSigning(ctx, provider, party.ctx, batch, 'SIGNING_STOPPED', new Set([order.id]))
      return released === 'approved' || released === 'cancelled'
        ? { ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { payment_order_id: order.id } }
        : { ok: false, code: 'PAYMENT_ORDERS_OUTCOME_UNKNOWN', details: { payment_order_id: order.id } }
    }
    order.provider_payment_id = created.providerPaymentId
    order.provider_payment_product = created.product
    order.provider_status = created.providerStatus
  }

  if (batch.signing_target === 'basket') {
    const withBasket = await createBasket(ctx, provider, party.ctx, batch, orders)
    if (!withBasket.ok) return withBasket.outcome
    batch = withBasket.batch
  }

  return beginSca(ctx, provider, party.ctx, batch, input.method)
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
  input: { batchId: string; method: SigningMethod; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const provider = getPaymentInitiationProvider(ctx.companyId)
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

  const party = await buildPartyContext(ctx, waiting[0]!, input.signer, { requireSigner: true })
  if (!party.ok) return party.outcome

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
  const refusal = await checkSigningCapabilities(provider, party.ctx, still.length)
  if (refusal) return refusal
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
  return beginSca(ctx, provider, party.ctx, next, input.method)
}

export async function pollPaymentSigning(
  ctx: OperationContext,
  input: { batchId: string; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const provider = getPaymentInitiationProvider(ctx.companyId)
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
  if (progress.state === 'pending') return { ok: true, data: view(batch, orders, progress.challenge, null) }

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
