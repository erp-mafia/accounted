/**
 * Status sync for payments the bank has not finished with (the cron).
 *
 * Open Payments has no webhooks for payments, so polling is the truth: every
 * order the bank holds and that is not final is read and moved forward
 * (accepted -> executed, a second signer done, a rejection). An order claimed
 * for signing whose payment never reached the bank (no provider id after
 * STALE_CLAIM_MINUTES) is failed: nothing was created, so nothing can execute.
 * That pass needs no provider and always runs; everything after it reads a
 * bank, so an installation without a payments provider stops there.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import {
  getPaymentInitiationProvider,
  hasPaymentInitiationProviders,
  PaymentProviderError,
  type PaymentPartyContext,
} from '@/lib/payments/initiation/provider'
import { applyProviderState } from './apply-state'
import type { PaymentOrderStatus } from './status'
import { logPaymentOrderEvents, type PaymentOrderBatchRow, type PaymentOrderBatchStatus, type PaymentOrderRow } from './types'

export const STALE_CLAIM_MINUTES = 30
/** A BankID signing nobody finished: BankID itself gives up after a few minutes. */
export const ABANDONED_SIGNING_MINUTES = 15
const BATCH_LIMIT = 200

/** Statuses only a finished signing reaches. */
const SIGNED: ReadonlySet<PaymentOrderStatus> = new Set(['awaiting_second_signer', 'accepted', 'executed'])

export interface PaymentStatusSyncResult {
  checked: number
  moved: number
  failedStale: number
  /** Signings nobody finished: the orders went back to 'submitted', to sign again or cancel. */
  abandoned: number
  /** Signings finished at the bank after the dialog closed: the batch now says so. */
  signedLate: number
  errors: number
  /** True when no payments provider is registered: only the stale-claim pass ran. */
  noProvider?: boolean
}

async function orgNumberFor(writer: SupabaseClient, companyId: string): Promise<string | null> {
  const { data: settings } = await writer.from('company_settings').select('org_number').eq('company_id', companyId).maybeSingle()
  const fromSettings = (settings as { org_number?: string | null } | null)?.org_number
  if (fromSettings) return fromSettings
  const { data: company } = await writer.from('companies').select('org_number').eq('id', companyId).maybeSingle()
  return (company as { org_number?: string | null } | null)?.org_number ?? null
}

/** Reading a payment's status needs the company and the debtor bank, never a signer. */
function statusParty(order: PaymentOrderRow, orgNumber: string): PaymentPartyContext {
  return {
    companyId: order.company_id,
    companyOrgNumber: orgNumber,
    accountContext: 'corporate',
    debtorBic: order.debtor_snapshot.bic,
    signerPersonalNumber: null,
    psuIpAddress: null,
    psuUserAgent: null,
  }
}

function errorCode(err: unknown): string {
  return err instanceof PaymentProviderError ? err.code : 'UNEXPECTED_ERROR'
}

/**
 * A signing started more than ABANDONED_SIGNING_MINUTES ago and never seen to
 * finish. The bank is asked first: the person may have signed and closed the
 * dialog before its next poll, and then the payments are accepted, not
 * abandoned. Only payments still unsigned go back to 'submitted'.
 */
async function settleAbandonedSignings(
  writer: SupabaseClient,
  log: Logger,
  result: PaymentStatusSyncResult,
  orgNumbers: Map<string, string | null>,
): Promise<void> {
  const abandonedBefore = new Date(Date.now() - ABANDONED_SIGNING_MINUTES * 60_000).toISOString()
  const { data: batches, error } = await writer
    .from('payment_order_batches')
    .select('*')
    .eq('status', 'awaiting_signature')
    .lt('signing_started_at', abandonedBefore)
    .limit(BATCH_LIMIT)
  if (error) throw error

  for (const batch of (batches ?? []) as PaymentOrderBatchRow[]) {
    const { data: orderData, error: ordersError } = await writer
      .from('payment_orders')
      .select('*')
      .eq('company_id', batch.company_id)
      .eq('batch_id', batch.id)
    if (ordersError) throw ordersError
    const orders = (orderData ?? []) as PaymentOrderRow[]

    const provider = getPaymentInitiationProvider(batch.company_id)
    if (provider && !orgNumbers.has(batch.company_id)) orgNumbers.set(batch.company_id, await orgNumberFor(writer, batch.company_id))
    const orgNumber = orgNumbers.get(batch.company_id) ?? null

    const statuses: PaymentOrderStatus[] = []
    let unknown = false
    for (const order of orders) {
      if (!provider || !orgNumber || !order.provider_payment_id || order.status !== 'awaiting_signature') {
        statuses.push(order.status)
        continue
      }
      result.checked += 1
      try {
        const state = await provider.getPaymentState(statusParty(order, orgNumber), order.provider_payment_id, order.provider_payment_product ?? 'domestic')
        const next = await applyProviderState(writer, order, state, null)
        if (next !== order.status) result.moved += 1
        statuses.push(next)
      } catch (err) {
        // Not knowing is not the same as abandoned: leave the batch for the next run.
        unknown = true
        result.errors += 1
        log.warn('payment status sync failed for one order', { orderId: order.id, code: errorCode(err) })
      }
    }
    if (unknown) continue

    if (statuses.some((s) => SIGNED.has(s))) {
      const to: PaymentOrderBatchStatus = statuses.includes('awaiting_second_signer') ? 'awaiting_second_signer' : 'signed'
      const { data: moved } = await writer
        .from('payment_order_batches')
        .update({ status: to, signed_at: new Date().toISOString() })
        .eq('id', batch.id)
        .eq('company_id', batch.company_id)
        .eq('status', 'awaiting_signature')
        .select('id')
      if ((moved ?? []).length === 1) {
        result.signedLate += 1
        await logPaymentOrderEvents(writer, [
          {
            company_id: batch.company_id,
            batch_id: batch.id,
            event_type: 'status_changed',
            from_status: 'awaiting_signature',
            to_status: to,
            detail: { source: 'status_sync' },
          },
        ])
      }
      continue
    }

    if (statuses.length > 0 && statuses.every((s) => s === 'rejected' || s === 'cancelled' || s === 'failed')) {
      // The bank closed every payment during the signing: nothing is left to sign again.
      const to: PaymentOrderBatchStatus = statuses.every((s) => s === 'rejected')
        ? 'rejected'
        : statuses.every((s) => s === 'cancelled')
          ? 'cancelled'
          : 'failed'
      await writer
        .from('payment_order_batches')
        .update({ status: to })
        .eq('id', batch.id)
        .eq('company_id', batch.company_id)
        .eq('status', 'awaiting_signature')
      continue
    }

    // Still unsigned: the payments wait at the bank, so the orders go back to
    // 'submitted', where they can be signed again or cancelled.
    const { data: reset } = await writer
      .from('payment_order_batches')
      .update({ status: 'created' })
      .eq('id', batch.id)
      .eq('company_id', batch.company_id)
      .eq('status', 'awaiting_signature')
      .select('id')
    if ((reset ?? []).length !== 1) continue
    await writer
      .from('payment_orders')
      .update({ status: 'submitted' })
      .eq('company_id', batch.company_id)
      .eq('batch_id', batch.id)
      .eq('status', 'awaiting_signature')
    result.abandoned += 1
    await logPaymentOrderEvents(writer, [
      { company_id: batch.company_id, batch_id: batch.id, event_type: 'error', detail: { code: 'SIGNING_ABANDONED' } },
    ])
  }
}

export async function syncPaymentOrderStatuses(writer: SupabaseClient, log: Logger): Promise<PaymentStatusSyncResult> {
  const result: PaymentStatusSyncResult = { checked: 0, moved: 0, failedStale: 0, abandoned: 0, signedLate: 0, errors: 0 }

  const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString()
  const { data: stale } = await writer
    .from('payment_orders')
    .update({ status: 'failed', provider_error_code: 'NOT_SENT_TO_BANK', provider_status_at: new Date().toISOString() })
    .eq('status', 'submitted')
    .is('provider_payment_id', null)
    .lt('submitted_at', staleBefore)
    .select('id, company_id')
  for (const row of (stale ?? []) as Array<{ id: string; company_id: string }>) {
    result.failedStale += 1
    await logPaymentOrderEvents(writer, [
      { company_id: row.company_id, payment_order_id: row.id, event_type: 'error', from_status: 'submitted', to_status: 'failed', detail: { code: 'NOT_SENT_TO_BANK' } },
    ])
  }

  // Dark installation: nothing below can be done without asking a bank.
  if (!hasPaymentInitiationProviders()) return { ...result, noProvider: true }

  const orgNumbers = new Map<string, string | null>()
  await settleAbandonedSignings(writer, log, result, orgNumbers)

  const { data, error } = await writer
    .from('payment_orders')
    .select('*')
    .in('status', ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'])
    .not('provider_payment_id', 'is', null)
    .order('provider_status_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_LIMIT)
  if (error) throw error
  const orders = (data ?? []) as PaymentOrderRow[]

  for (const order of orders) {
    const provider = getPaymentInitiationProvider(order.company_id)
    if (!provider || !order.provider_payment_id) continue
    if (!orgNumbers.has(order.company_id)) orgNumbers.set(order.company_id, await orgNumberFor(writer, order.company_id))
    const orgNumber = orgNumbers.get(order.company_id)
    if (!orgNumber) continue
    result.checked += 1
    try {
      const state = await provider.getPaymentState(statusParty(order, orgNumber), order.provider_payment_id, order.provider_payment_product ?? 'domestic')
      const next = await applyProviderState(writer, order, state, null)
      if (next !== order.status) result.moved += 1
    } catch (err) {
      result.errors += 1
      log.warn('payment status sync failed for one order', { orderId: order.id, code: errorCode(err) })
    }
  }
  return result
}
