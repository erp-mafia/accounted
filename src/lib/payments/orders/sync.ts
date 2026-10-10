/**
 * Status sync for payments the bank has not finished with (the cron).
 *
 * Open Payments has no webhooks for payments, so polling is the truth: every
 * order the bank holds and that is not final is read and moved forward
 * (accepted -> executed, a second signer done, a rejection).
 *
 * First, claims nobody finished (sweep_stale_payment_order_claims): a create
 * whose write-ahead marker is older than STALE_CREATE_MINUTES never got the
 * bank's answer, so nobody knows what the bank holds; it is marked outcome
 * unknown (the payment_orders migration, rule 1) and stays in payment until
 * its debit or a person resolves it. A claimed order whose create never
 * started was never sent and is released. That pass needs no provider and
 * always runs; everything after it reads a bank, so an installation without
 * a payments provider stops there.
 *
 * An unsigned payment whose invoice no longer needs paying (paid another way,
 * credited) is cancelled at the bank, once: a confirmed cancel cancels the
 * order, any other answer holds it for a person (release.ts).
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
import { cancelForClosedInvoice, unpayableOrders } from './release'
import type { PaymentOrderStatus } from './status'
import { logPaymentOrderEvents, type PaymentOrderBatchRow, type PaymentOrderBatchStatus, type PaymentOrderRow } from './types'

/**
 * How long a create may run before it counts as dead: well past the signing
 * routes' maxDuration (300 s), so a live create is never swept. The database
 * refuses anything under ten minutes.
 */
export const STALE_CREATE_MINUTES = 15
/** A BankID signing nobody finished: BankID itself gives up after a few minutes. */
export const ABANDONED_SIGNING_MINUTES = 15
const BATCH_LIMIT = 200

/** Statuses only a finished signing reaches. */
const SIGNED: ReadonlySet<PaymentOrderStatus> = new Set(['awaiting_second_signer', 'accepted', 'executed'])

export interface PaymentStatusSyncResult {
  checked: number
  moved: number
  /** Creates older than STALE_CREATE_MINUTES that never got the bank's answer, now marked outcome unknown. */
  markedUnknown: number
  /** Claims whose create never started: released (or cancelled when their invoice closed). */
  released: number
  /** Unsigned payments cancelled at the bank because their invoice no longer needs paying. */
  cancelledForClosedInvoice: number
  /** Such payments whose cancel the bank did not confirm: held for a person. */
  heldForPerson: number
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
    const attempt = batch.provider_authorisation_id
    if (!attempt) continue
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
    // Not knowing is not the same as abandoned: without a bank to ask, the
    // signing is left for a run that can ask.
    if (!provider || !orgNumber) continue

    const statuses: PaymentOrderStatus[] = []
    let unknown = false
    for (const order of orders) {
      if (order.status !== 'awaiting_signature') {
        statuses.push(order.status)
        continue
      }
      if (!order.provider_payment_id) {
        unknown = true
        break
      }
      result.checked += 1
      try {
        const state = await provider.getPaymentState(statusParty(order, orgNumber), order.provider_payment_id, order.provider_payment_product ?? 'domestic')
        const next = await applyProviderState(writer, order, state, null, log)
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
        .eq('provider_authorisation_id', attempt)
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
        ], log)
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
        .eq('provider_authorisation_id', attempt)
      continue
    }

    // Still unsigned: the payments wait at the bank, so the orders go back to
    // 'submitted', where they can be signed again or cancelled. Only the
    // attempt that was read is reset: a restart since then has its own id.
    const { data: reset } = await writer
      .from('payment_order_batches')
      .update({ status: 'created' })
      .eq('id', batch.id)
      .eq('company_id', batch.company_id)
      .eq('status', 'awaiting_signature')
      .eq('provider_authorisation_id', attempt)
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
    ], log)
  }
}

/** Orders whose payment the status sync already asked the bank to cancel for a closed invoice: held for a person. */
async function closedInvoiceCancelsAsked(writer: SupabaseClient, orders: PaymentOrderRow[]): Promise<Set<string>> {
  if (orders.length === 0) return new Set()
  const { data, error } = await writer
    .from('payment_order_events')
    .select('payment_order_id, detail')
    .eq('event_type', 'cancel_requested')
    .in('payment_order_id', orders.map((o) => o.id))
  if (error) throw error
  const asked = new Set<string>()
  for (const row of (data ?? []) as Array<{ payment_order_id: string; detail: { source?: string; provider_payment_id?: string } | null }>) {
    if (row.detail?.source === 'invoice_closed' && row.detail.provider_payment_id) asked.add(`${row.payment_order_id}:${row.detail.provider_payment_id}`)
  }
  return asked
}

export async function syncPaymentOrderStatuses(writer: SupabaseClient, log: Logger): Promise<PaymentStatusSyncResult> {
  const result: PaymentStatusSyncResult = {
    checked: 0,
    moved: 0,
    markedUnknown: 0,
    released: 0,
    abandoned: 0,
    signedLate: 0,
    cancelledForClosedInvoice: 0,
    heldForPerson: 0,
    errors: 0,
  }

  const staleBefore = new Date(Date.now() - STALE_CREATE_MINUTES * 60_000).toISOString()
  const { data: swept, error: sweepError } = await writer.rpc('sweep_stale_payment_order_claims', { p_before: staleBefore })
  if (sweepError) {
    result.errors += 1
    log.error('stale payment order claims could not be swept', sweepError)
  } else {
    const counts = swept as { marked_unknown?: number; released?: number } | null
    result.markedUnknown = counts?.marked_unknown ?? 0
    result.released = counts?.released ?? 0
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

  // Unsigned payments whose invoice no longer needs paying, and those already asked about once.
  const unsigned = orders.filter((o) => o.status === 'submitted')
  const unpayable = await unpayableOrders(writer, unsigned)
  const asked = await closedInvoiceCancelsAsked(writer, unsigned.filter((o) => unpayable.has(o.id)))

  for (const order of orders) {
    const provider = getPaymentInitiationProvider(order.company_id)
    if (!provider || !order.provider_payment_id) continue
    if (!orgNumbers.has(order.company_id)) orgNumbers.set(order.company_id, await orgNumberFor(writer, order.company_id))
    const orgNumber = orgNumbers.get(order.company_id)
    if (!orgNumber) continue
    result.checked += 1
    let next: PaymentOrderStatus
    try {
      const state = await provider.getPaymentState(statusParty(order, orgNumber), order.provider_payment_id, order.provider_payment_product ?? 'domestic')
      next = await applyProviderState(writer, order, state, null, log)
      if (next !== order.status) result.moved += 1
    } catch (err) {
      result.errors += 1
      log.warn('payment status sync failed for one order', { orderId: order.id, code: errorCode(err) })
      continue
    }
    if (next !== 'submitted' || !unpayable.has(order.id) || asked.has(`${order.id}:${order.provider_payment_id}`)) continue
    const outcome = await cancelForClosedInvoice(writer, { userId: null, log }, provider, statusParty(order, orgNumber), order)
    if (outcome === 'cancelled' || outcome === 'released') result.cancelledForClosedInvoice += 1
    else if (outcome === 'held') result.heldForPerson += 1
  }
  return result
}
