/**
 * Signing approved payment orders with BankID.
 *
 *   start:  company verified at the provider -> claim the orders (one atomic
 *           RPC: approved -> submitted, one signing batch) -> create each
 *           payment at the bank ONCE -> a signing basket when there are
 *           several -> start BankID and hand the challenge (autostart token or
 *           QR data) to the person.
 *   poll:   the person's screen polls; pending returns fresh QR data, a failed
 *           signing sends the orders back to 'submitted' (sign again), a
 *           finalised one reads each payment's status and applies it.
 *
 * Payment APIs may have no idempotency (Open Payments creates a second payment
 * for a repeated request), so a payment is never created twice: the claim
 * makes the orders 'submitted' before any call, and a creation that fails or
 * times out fails the order instead of retrying. An unsigned payment left at
 * the bank is harmless: nothing executes without the signature.
 */

import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import {
  getPaymentInitiationProvider,
  PaymentProviderError,
  type PaymentInitiationProvider,
  type PaymentInstruction,
  type PaymentPartyContext,
  type SigningChallenge,
  type SigningTarget,
} from '@/lib/payments/initiation/provider'
import { createServiceClient } from '@/lib/supabase/server'
import { applyProviderState } from './apply-state'
import { buildPartyContext, type SignerInput } from './party'
import { logPaymentOrderEvents, type PaymentOrderBatchRow, type PaymentOrderRow } from './types'

export type SigningMethod = 'same_device' | 'qr'

export interface SigningView {
  batch_id: string
  status: PaymentOrderBatchRow['status']
  challenge: SigningChallenge | null
  failure_code: string | null
  orders: Array<{ id: string; status: string; provider_status: string | null }>
}

/**
 * Codes after which signing again cannot help: the person lacks the rights,
 * the bank refused for good, or the bank only signs on its own page. Signing
 * on the bank's page (the redirect approach) is not supported yet: it needs
 * the connection callback that milestone 1 adds with the Connect adapter, so
 * until then those orders close and the invoices can go into a payment file.
 */
const PERMANENT_SIGNING_FAILURES = new Set(['PSU_RIGHTS_MISSING', 'BANKID_NOT_ACTIVATED', 'TPP_KYC_INVALID', 'SCA_REDIRECT_UNSUPPORTED'])

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

function providerFailure(error: unknown): { code: string; outcome: string } {
  if (error instanceof PaymentProviderError) {
    return { code: error.code, outcome: error.retryable ? 'PAYMENT_PROVIDER_UNAVAILABLE' : 'PAYMENT_PROVIDER_REFUSED' }
  }
  return { code: 'UNEXPECTED_ERROR', outcome: 'PAYMENT_PROVIDER_REFUSED' }
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

async function failSigning(
  ctx: OperationContext,
  batchId: string,
  orders: PaymentOrderRow[],
  code: string,
  message: string | null,
): Promise<void> {
  const writer = createServiceClient()
  const now = new Date().toISOString()
  for (const order of orders) {
    const { data } = await writer
      .from('payment_orders')
      .update({ status: 'failed', provider_error_code: code, provider_error_message: message?.slice(0, 500) ?? null, provider_status_at: now })
      .eq('id', order.id)
      .eq('company_id', ctx.companyId)
      .in('status', ['submitted', 'awaiting_signature'])
      .select('id')
    if ((data ?? []).length === 1) {
      await logPaymentOrderEvents(writer, [
        {
          company_id: ctx.companyId,
          payment_order_id: order.id,
          batch_id: batchId,
          event_type: 'error',
          from_status: order.status,
          to_status: 'failed',
          actor_user_id: ctx.userId,
          detail: { code },
        },
      ])
    }
  }
  await writer.from('payment_order_batches').update({ status: 'failed' }).eq('id', batchId).eq('company_id', ctx.companyId).in('status', ['created', 'awaiting_signature'])
}

async function loadBatch(ctx: OperationContext, batchId: string): Promise<{ batch: PaymentOrderBatchRow; orders: PaymentOrderRow[] } | null> {
  const { data: batch } = await ctx.supabase
    .from('payment_order_batches')
    .select('*')
    .eq('id', batchId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (!batch) return null
  const { data: orders, error } = await ctx.supabase
    .from('payment_orders')
    .select('*')
    .eq('company_id', ctx.companyId)
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
    orders: orders.map((o) => ({ id: o.id, status: o.status, provider_status: o.provider_status })),
  }
}

async function beginSca(
  ctx: OperationContext,
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  orders: PaymentOrderRow[],
  method: SigningMethod,
): Promise<OperationOutcome<SigningView>> {
  const writer = createServiceClient()
  const target = targetOf(batch, orders)
  if (!target) return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  let started
  try {
    started = await provider.startSigning(party, target, method)
  } catch (error) {
    const failure = providerFailure(error)
    ctx.log.warn('payment signing did not start', { batchId: batch.id, code: failure.code })
    if (PERMANENT_SIGNING_FAILURES.has(failure.code)) {
      // Signing again cannot help: close the orders so the invoices can be paid another way.
      await failSigning(ctx, batch.id, orders, failure.code, null)
    }
    const code = failure.code === 'SCA_REDIRECT_UNSUPPORTED' ? 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED' : failure.outcome
    return { ok: false, code, details: { provider_code: failure.code } }
  }
  const now = new Date().toISOString()
  const { data: updated } = await writer
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
    .eq('status', batch.status)
    .select('*')
    .maybeSingle()
  if (!updated) return { ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' }
  await writer
    .from('payment_orders')
    .update({ status: 'awaiting_signature' })
    .eq('company_id', ctx.companyId)
    .eq('batch_id', batch.id)
    .eq('status', 'submitted')
  await logPaymentOrderEvents(writer, [
    { company_id: ctx.companyId, batch_id: batch.id, event_type: 'signing_started', actor_user_id: ctx.userId, detail: { method: started.method } },
  ])
  const refreshed = await loadBatch(ctx, batch.id)
  return { ok: true, data: view(updated as PaymentOrderBatchRow, refreshed?.orders ?? orders, started.challenge, null) }
}

export async function startPaymentSigning(
  ctx: OperationContext,
  input: { orderIds: string[]; method: SigningMethod; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const ids = [...new Set(input.orderIds)]
  if (ids.length === 0) return { ok: false, code: 'PAYMENT_ORDERS_EMPTY_SELECTION' }
  const provider = getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }

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

  const party = await buildPartyContext(ctx, previewOrders[0]!, input.signer, { requireSigner: true })
  if (!party.ok) return party.outcome

  // Before anything is claimed: a company the provider has not verified would
  // have every payment refused (TPP_KYC_INVALID).
  try {
    const verification = await provider.getCompanyVerification(party.ctx)
    if (verification.status !== 'valid') return { ok: false, code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED' }
  } catch (error) {
    const failure = providerFailure(error)
    return { ok: false, code: failure.outcome, details: { provider_code: failure.code } }
  }

  const { data: claim, error: claimError } = await ctx.supabase.rpc('claim_payment_orders_for_signing', {
    p_company_id: ctx.companyId,
    p_order_ids: ids,
    p_provider: provider.id,
    p_user_id: ctx.userId,
  })
  if (claimError) throw claimError
  const claimed = claim as { ok: boolean; code?: string; batch?: PaymentOrderBatchRow; orders?: PaymentOrderRow[] }
  if (!claimed.ok || !claimed.batch || !claimed.orders) {
    const code = claimed.code === 'mixed_accounts' ? 'PAYMENT_ORDERS_MIXED_ACCOUNTS' : claimed.code === 'not_found' ? 'PAYMENT_ORDER_NOT_FOUND' : 'PAYMENT_ORDERS_WRONG_STATUS'
    return { ok: false, code }
  }

  const writer = createServiceClient()
  const batch = claimed.batch
  const orders = claimed.orders
  for (const order of orders) {
    try {
      const created = await provider.createPayment(party.ctx, instructionFor(order))
      const { error } = await writer
        .from('payment_orders')
        .update({
          provider_payment_id: created.providerPaymentId,
          provider_payment_product: created.product,
          provider_status: created.providerStatus,
          provider_status_at: new Date().toISOString(),
        })
        .eq('id', order.id)
        .eq('company_id', ctx.companyId)
      if (error) throw error
      order.provider_payment_id = created.providerPaymentId
      order.provider_payment_product = created.product
      order.provider_status = created.providerStatus
    } catch (error) {
      const failure = providerFailure(error)
      ctx.log.warn('payment creation at the bank failed', { orderId: order.id, code: failure.code })
      await failSigning(ctx, batch.id, orders, failure.code, error instanceof Error ? error.message : null)
      return { ok: false, code: failure.outcome, details: { provider_code: failure.code, payment_order_id: order.id } }
    }
  }

  if (batch.signing_target === 'basket') {
    try {
      const basket = await provider.createSigningBasket(
        party.ctx,
        orders.map((o) => o.provider_payment_id as string),
      )
      const { data: withBasket } = await writer
        .from('payment_order_batches')
        .update({ provider_batch_id: basket.providerBasketId })
        .eq('id', batch.id)
        .eq('company_id', ctx.companyId)
        .select('*')
        .maybeSingle()
      if (withBasket) Object.assign(batch, withBasket)
    } catch (error) {
      const failure = providerFailure(error)
      await failSigning(ctx, batch.id, orders, failure.code, error instanceof Error ? error.message : null)
      return { ok: false, code: failure.outcome, details: { provider_code: failure.code } }
    }
  }

  return beginSca(ctx, provider, party.ctx, batch, orders, input.method)
}

/** Start BankID again for a signing that was abandoned or timed out. */
export async function restartPaymentSigning(
  ctx: OperationContext,
  input: { batchId: string; method: SigningMethod; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const provider = getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  const loaded = await loadBatch(ctx, input.batchId)
  if (!loaded) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  if (loaded.batch.status !== 'created' || loaded.orders.some((o) => o.status !== 'submitted')) {
    return { ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' }
  }
  const party = await buildPartyContext(ctx, loaded.orders[0]!, input.signer, { requireSigner: true })
  if (!party.ok) return party.outcome
  return beginSca(ctx, provider, party.ctx, loaded.batch, loaded.orders, input.method)
}

export async function pollPaymentSigning(
  ctx: OperationContext,
  input: { batchId: string; signer: SignerInput },
): Promise<OperationOutcome<SigningView>> {
  const provider = getPaymentInitiationProvider(ctx.companyId)
  if (!provider) return { ok: false, code: 'PAYMENTS_UNAVAILABLE' }
  const loaded = await loadBatch(ctx, input.batchId)
  if (!loaded) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
  const { batch, orders } = loaded
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
    const failure = providerFailure(error)
    return { ok: false, code: failure.outcome, details: { provider_code: failure.code } }
  }
  if (progress.state === 'pending') return { ok: true, data: view(batch, orders, progress.challenge, null) }

  const writer = createServiceClient()
  if (progress.state === 'failed') {
    const code = progress.failureCode ?? 'SCA_FAILED'
    if (PERMANENT_SIGNING_FAILURES.has(code)) {
      await failSigning(ctx, batch.id, orders, code, null)
    } else {
      // Abandoned, cancelled or timed out: the payments still wait at the bank
      // and can be signed again.
      await writer.from('payment_order_batches').update({ status: 'created' }).eq('id', batch.id).eq('company_id', ctx.companyId).eq('status', 'awaiting_signature')
      await writer.from('payment_orders').update({ status: 'submitted' }).eq('company_id', ctx.companyId).eq('batch_id', batch.id).eq('status', 'awaiting_signature')
      await logPaymentOrderEvents(writer, [
        { company_id: ctx.companyId, batch_id: batch.id, event_type: 'error', actor_user_id: ctx.userId, detail: { code, stage: 'signing' } },
      ])
    }
    const after = await loadBatch(ctx, batch.id)
    return { ok: true, data: view(after?.batch ?? batch, after?.orders ?? orders, null, code) }
  }

  // Finalised. The signing, not the payment status, says it succeeded; now
  // read where each payment stands (a second signer, accepted, executed).
  const statuses: string[] = []
  for (const order of orders) {
    if (!order.provider_payment_id) continue
    try {
      const state = await provider.getPaymentState(party.ctx, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
      statuses.push(await applyProviderState(writer, order, state, ctx.userId))
    } catch (error) {
      ctx.log.warn('payment status after signing could not be read', { orderId: order.id, code: providerFailure(error).code })
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
  const after = await loadBatch(ctx, batch.id)
  return { ok: true, data: view(after?.batch ?? batch, after?.orders ?? orders, null, null) }
}
