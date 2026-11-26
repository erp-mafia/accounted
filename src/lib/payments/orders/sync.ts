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
 *
 * Last, the sweeps: an executed order still unsettled whose debit is already
 * in the feed and still unbooked (the debit arrived before the bank reported
 * the payment executed, or before this release) is booked with it
 * (auto-settle.ts), the same way ingest books a debit that arrives after.
 * And a signed order without an invoice (skattekonto, salary) whose debit is
 * in the feed, booked or not, is linked to it and executed (linkOrderToDebit):
 * a bank may answer RCVD long after the money left.
 *
 * Every run, bank or not, clears the signer's IP address of each signing none
 * of whose orders is at the bank any more (forgetIpsOfClosedSignings): it is
 * personal data kept only for the reads and cancels above.
 *
 * Bounded three ways, because every read is a call to a bank that may take
 * 30 s to fail. The run asks its budget (lib/api/run-budget.ts) before each
 * bank read and leaves the rest for the next run, oldest answer first, so
 * the platform never kills it mid-run with the mails and sweeps after it
 * undone. The banks take turns (readingOrder), and one whose read goes
 * unanswered goes last: asked again only once every other bank's payments
 * are read, so a bank that is down, or a payment whose read always fails,
 * costs the others one timeout, and that bank's other payments are still
 * reached while time is left. Abandoned signings are worked in the first
 * half of the budget and by the same rule. The two debit
 * sweeps make no bank call and have a budget of their own. And a payment
 * planned for a later day is read every few hours, not every run
 * (isDueForStatusRead).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { storedBatchSigner, type StoredBatchSigner } from '@/lib/auth/resource-psu'
import { companyOrgNumber } from '@/lib/company/org-number'
import type { Logger } from '@/lib/logger'
import {
  getPaymentInitiationProvider,
  hasPaymentInitiationProviders,
  PAYMENT_NOT_FOUND,
  PaymentProviderError,
  type PaymentInitiationProvider,
  type PaymentPartyContext,
  type SigningProgress,
} from '@/lib/payments/initiation/provider'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { UNLIMITED_RUN, type RunBudget } from '@/lib/api/run-budget'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Transaction } from '@/types'
import { applyProviderState } from './apply-state'
import { linkOrderToDebit, settleOrderWithDebit, withFinishedSignings } from './auto-settle'
import {
  DEBIT_FEEDS,
  DEBIT_LINKABLE_ORDER_STATUSES,
  DEBIT_WINDOW_DAYS_AFTER,
  DEBIT_WINDOW_DAYS_BEFORE,
  debitOfTransaction,
  findLinkableOrderForDebit,
  findOrderForDebit,
  isDebitLinkableOrder,
  isDebitSettleableOrder,
  type DebitLinkBasis,
  type DebitMatchBasis,
} from './debit-match'
import { paymentAccountContext } from './debtor'
import { cancelForClosedInvoice, endFailedSigning, unpayableOrders } from './release'
import { SCHEDULED_PAYMENT_AHEAD_DAYS, SCHEDULED_PAYMENT_READ_EVERY_MS, UNANSWERED_SIGNING_MINUTES, type PaymentOrderStatus } from './status'
import { logPaymentOrderEvents, signingTargetOf, type PaymentOrderBatchRow, type PaymentOrderBatchStatus, type PaymentOrderRow } from './types'

/**
 * How long a create may run before it counts as dead: well past the signing
 * routes' maxDuration (300 s), so a live create is never swept. The database
 * refuses anything under ten minutes.
 */
export const STALE_CREATE_MINUTES = 15
/** A BankID signing nobody finished: BankID itself gives up after a few minutes. */
export const ABANDONED_SIGNING_MINUTES = 15
/** How long the sync keeps asking about a BankID it cannot see end (defined in status.ts). */
export { UNANSWERED_SIGNING_MINUTES }
const BATCH_LIMIT = 200
/**
 * Reads in a row one bank may leave unanswered in a run (unreachable, a 5xx,
 * a throttle, a timeout) before its payments go last: each may take the
 * provider's whole timeout, and the bank is no better a second later. One:
 * at two, three banks down together were six timeouts, the whole budget,
 * before a fourth bank was asked twice. Going last costs a bank that only
 * hiccuped nothing but its place in the run.
 */
export const UNANSWERED_READS_PER_BANK = 1
/**
 * Abandoned signings are started only while this much of the read budget is
 * left: a signing is several bank calls and cannot be picked up half way, so
 * a large or slow one must not take the time of every payment read after it.
 */
export const SIGNING_PASS_RESERVE_MS = 90_000
/** A planned payment someone asked the bank to cancel this recently is read on every run (cancelAskedRecently). */
export const CANCEL_FOLLOW_DAYS = 7
/** An executed order is swept for its debit this long after the bank executed it. */
export const EXECUTED_ORDER_SWEEP_DAYS = 14
/**
 * The debit read is bounded by booking date; the matcher then applies the
 * exact window to the booking date or the value date, which may lie a few
 * days apart around a weekend.
 */
const DEBIT_READ_SLACK_DAYS = 3

/**
 * An order whose payment is still at the bank: read by this sync, and
 * cancelled when its invoice closed. Its signing's kept IP address stays
 * while one of its orders is in one of these.
 */
const AT_THE_BANK: readonly PaymentOrderStatus[] = ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted']

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
  /**
   * Signings nobody finished: when the bank reports their BankID failed, their
   * payments cancelled at the bank and the orders back to approved; when it
   * still had not UNANSWERED_SIGNING_MINUTES on, the orders back to 'submitted'.
   */
  abandoned: number
  /** Signings finished at the bank after the dialog closed: the batch now says so. */
  signedLate: number
  /** Executed orders settled by a debit already in the feed (auto-settle.ts). */
  settledByDebit: number
  /** Orders without an invoice (skattekonto, salary) linked to their debit in the feed and executed (linkOrderToDebit). */
  linkedByDebit: number
  /** Signings none of whose orders is at the bank any more whose signer's IP address was cleared. */
  forgottenIps: number
  /** Orders and signings the run's budget left for the next run: not asked, nothing lost. */
  deferred: number
  /** Banks that left UNANSWERED_READS_PER_BANK reads in a row unanswered in this run: their payments were asked about last. */
  banksNotAnswering: number
  errors: number
  /** True when no payments provider is registered: only the stale-claim pass ran. */
  noProvider?: boolean
}

/**
 * Reading a payment's status (or cancelling it) unattended: the company, the
 * debtor bank, the PSU-ID the payment was created with (several banks
 * require the same one on every later call to it) and the IP address the
 * signing was started from (Länsförsäkringar and SEB refuse a status read
 * without a PSU-IP-Address), both from payment_batch_psus; null when none is
 * kept, never a guessed or a server address. No person is present, so no
 * user agent.
 */
function statusParty(order: PaymentOrderRow, orgNumber: string, signer: StoredBatchSigner): PaymentPartyContext {
  return {
    companyId: order.company_id,
    companyOrgNumber: orgNumber,
    accountContext: paymentAccountContext(order.debtor_snapshot.psu_type),
    debtorBic: order.debtor_snapshot.bic,
    affiliatedAspspId: order.debtor_snapshot.affiliated_aspsp_id ?? null,
    signerPersonalNumber: signer.psuId,
    psuIpAddress: signer.ipAddress,
    psuUserAgent: null,
  }
}

/** The PSU-ID and IP address each signing's payments were created with, read once per signing and run. */
type BatchPsuOf = (batchId: string | null) => Promise<StoredBatchSigner>

const NO_SIGNER: StoredBatchSigner = { psuId: null, ipAddress: null }

function batchPsuReader(): BatchPsuOf {
  const read = new Map<string, Promise<StoredBatchSigner>>()
  return (batchId) => {
    if (!batchId) return Promise.resolve(NO_SIGNER)
    let psu = read.get(batchId)
    if (!psu) {
      psu = storedBatchSigner(batchId)
      read.set(batchId, psu)
    }
    return psu
  }
}

function errorCode(err: unknown): string {
  return err instanceof PaymentProviderError ? err.code : 'UNEXPECTED_ERROR'
}

/**
 * A read the bank refused outright rather than one that failed on the way:
 * Connect answers 422 for the bank's refusal and the port says
 * PAYMENT_NOT_FOUND for a payment the bank does not know. Asked the same way,
 * it is refused on every run. SEB and Länsförsäkringar refuse a status read
 * without a PSU-IP-Address ("PSU-IP-Address is mandatory for payment",
 * "Invalid PSU-IP-Address"), and no address is kept for a signing started
 * before payment_batch_psus.psu_ip_address existed. An unreachable service, a
 * 5xx, a throttle or a lost answer is not a refusal: the next run asks again.
 */
function isRefusedRead(err: unknown): boolean {
  return (
    err instanceof PaymentProviderError &&
    !err.retryable &&
    !err.outcomeUnknown &&
    (err.httpStatus === 422 || err.code === PAYMENT_NOT_FOUND)
  )
}

/**
 * A read the bank (or the service in front of it) never answered: unreachable,
 * a 5xx, a throttle, a timeout. The provider calls those retryable; a refusal
 * is an answer.
 */
function isUnansweredRead(err: unknown): boolean {
  return err instanceof PaymentProviderError ? err.retryable : false
}

/**
 * Which banks are answering in this run. A bank is the BIC the money leaves
 * from and, behind a shared BIC, its sparbank: the provider reaches each
 * through its own connection.
 */
interface BankHealth {
  /** Whether the order's bank has answered since its last UNANSWERED_READS_PER_BANK reads. */
  answers(order: PaymentOrderRow): boolean
  /** A read of the order's bank that went unanswered. */
  unanswered(order: PaymentOrderRow): void
  /** A read of the order's bank that was answered, a refusal included: it is there. */
  answered(order: PaymentOrderRow): void
  /** Banks that at some point in the run were not answering. */
  notAnswering(): number
}

function bankKey(order: PaymentOrderRow): string {
  return `${order.debtor_snapshot.bic}:${order.debtor_snapshot.affiliated_aspsp_id ?? ''}`
}

function bankHealth(): BankHealth {
  const inARow = new Map<string, number>()
  const silent = new Set<string>()
  return {
    answers: (order) => (inARow.get(bankKey(order)) ?? 0) < UNANSWERED_READS_PER_BANK,
    unanswered: (order) => {
      const key = bankKey(order)
      const count = (inARow.get(key) ?? 0) + 1
      inARow.set(key, count)
      if (count >= UNANSWERED_READS_PER_BANK) silent.add(key)
    },
    answered: (order) => {
      inARow.delete(bankKey(order))
    },
    notAnswering: () => silent.size,
  }
}

/**
 * The order one run reads its payments in: the banks take turns, each
 * handing over its payment with the oldest answer, and a bank that is not
 * answering (BankHealth) is passed over until every other bank's payments
 * are read. So no bank waits behind another's slow or failing reads, and a
 * bank with two payments whose read always fails still gets its other
 * payments read, after everyone else's. Asked for one payment at a time,
 * since a read changes which banks answer.
 */
function readingOrder(orders: readonly PaymentOrderRow[], banks: BankHealth): () => PaymentOrderRow | null {
  const queues = new Map<string, PaymentOrderRow[]>()
  for (const order of orders) {
    const queue = queues.get(bankKey(order))
    if (queue) queue.push(order)
    else queues.set(bankKey(order), [order])
  }
  const turns = [...queues.values()]
  let turn = 0
  return () => {
    for (const answering of [true, false]) {
      for (let step = 0; step < turns.length; step++) {
        const queue = turns[(turn + step) % turns.length]
        if (queue.length > 0 && banks.answers(queue[0]) === answering) {
          turn = (turn + step + 1) % turns.length
          return queue.shift() ?? null
        }
      }
    }
    return null
  }
}

/** What bounds the bank reads of one run: its time and which banks are answering. */
interface RunLimits {
  budget: RunBudget
  banks: BankHealth
}

/**
 * Whether a payment at the bank is asked about in this run. One planned for
 * a later day (accepted, more than SCHEDULED_PAYMENT_AHEAD_DAYS ahead on the
 * Swedish calendar) only when its last answer is SCHEDULED_PAYMENT_READ_EVERY_MS
 * old; every other one, and one never answered about, on every run. So is a
 * planned payment someone asked the bank to cancel (cancelAsked): the bank
 * may want the cancel signed in the online bank, and the person who did that
 * is waiting to see it here (lifecycle.ts, crm#1699).
 */
export function isDueForStatusRead(
  order: Pick<PaymentOrderRow, 'status' | 'requested_execution_date' | 'provider_status_at'>,
  now: Date = new Date(),
  cancelAsked = false,
): boolean {
  if (order.status !== 'accepted' || cancelAsked) return true
  if (!(order.requested_execution_date > addDaysIso(todayIsoStockholm(now), SCHEDULED_PAYMENT_AHEAD_DAYS))) return true
  const answered = order.provider_status_at ? Date.parse(order.provider_status_at) : Number.NaN
  return !Number.isFinite(answered) || now.getTime() - answered >= SCHEDULED_PAYMENT_READ_EVERY_MS
}

/**
 * A signing started more than ABANDONED_SIGNING_MINUTES ago and never seen to
 * finish. The bank is asked first: the person may have signed and closed the
 * dialog before its next poll, and then the payments are accepted, not
 * abandoned. While they still read unsigned, or the bank refuses the read
 * (isRefusedRead), the BankID itself is asked: one that finalised is a
 * signing the bank is still confirming; one that failed gets its payments
 * cancelled at the bank and its orders let go
 * (endFailedSigning); one still open, or unreadable, is left for the next run
 * until UNANSWERED_SIGNING_MINUTES, then its orders go back to 'submitted'.
 */
async function settleAbandonedSignings(
  writer: SupabaseClient,
  log: Logger,
  result: PaymentStatusSyncResult,
  orgNumbers: Map<string, string | null>,
  psuOf: BatchPsuOf,
  limits: RunLimits,
): Promise<void> {
  const abandonedBefore = new Date(Date.now() - ABANDONED_SIGNING_MINUTES * 60_000).toISOString()
  const { data: batches, error } = await writer
    .from('payment_order_batches')
    .select('*')
    .eq('status', 'awaiting_signature')
    .lt('signing_started_at', abandonedBefore)
    .limit(BATCH_LIMIT)
  if (error) throw error

  // A signing whose bank is not answering goes to the back of the list once,
  // as a payment does (readingOrder): the signings of every other bank first.
  const signings = ((batches ?? []) as PaymentOrderBatchRow[]).map((batch) => ({ batch, postponed: false }))
  for (let index = 0; index < signings.length; index++) {
    const { batch, postponed } = signings[index]
    // Out of time for another signing: it and the ones after it wait for the next run, as an unreadable one does.
    if (!limits.budget.allows(SIGNING_PASS_RESERVE_MS)) {
      result.deferred += signings.length - index
      break
    }
    const attempt = batch.provider_authorisation_id
    if (!attempt) continue
    const { data: orderData, error: ordersError } = await writer
      .from('payment_orders')
      .select('*')
      .eq('company_id', batch.company_id)
      .eq('batch_id', batch.id)
    if (ordersError) throw ordersError
    const orders = (orderData ?? []) as PaymentOrderRow[]

    const provider = await getPaymentInitiationProvider(batch.company_id)
    if (provider && !orgNumbers.has(batch.company_id)) orgNumbers.set(batch.company_id, await companyOrgNumber(writer, batch.company_id))
    const orgNumber = orgNumbers.get(batch.company_id) ?? null
    // Not knowing is not the same as abandoned: without a bank to ask, the
    // signing is left for a run that can ask.
    if (!provider || !orgNumber) continue
    if (!postponed && orders.some((order) => order.status === 'awaiting_signature' && !limits.banks.answers(order))) {
      signings.push({ batch, postponed: true })
      continue
    }

    const statuses: PaymentOrderStatus[] = []
    let unknown = false
    // A payment whose status the bank refuses to give is not known to be
    // signed or closed: the BankID decides below, as for one still reading
    // unsigned. Waiting would not help, the next run is refused the same way.
    let refused = false
    for (const order of orders) {
      if (order.status !== 'awaiting_signature') {
        statuses.push(order.status)
        continue
      }
      if (!order.provider_payment_id) {
        unknown = true
        break
      }
      // Not asked is not known either: out of time leaves the signing for the next run.
      if (!limits.budget.allows()) {
        result.deferred += 1
        unknown = true
        break
      }
      result.checked += 1
      try {
        const state = await provider.getPaymentState(statusParty(order, orgNumber, await psuOf(batch.id)), order.provider_payment_id, order.provider_payment_product ?? 'domestic')
        limits.banks.answered(order)
        const next = await applyProviderState(writer, order, state, null, log)
        if (next !== order.status) result.moved += 1
        statuses.push(next)
      } catch (err) {
        result.errors += 1
        log.warn('payment status sync failed for one order', { orderId: order.id, code: errorCode(err) })
        if (isUnansweredRead(err)) limits.banks.unanswered(order)
        else if (err instanceof PaymentProviderError) limits.banks.answered(order)
        // Not knowing is not the same as abandoned: a read that failed on the
        // way leaves the batch for the next run.
        if (isRefusedRead(err)) refused = true
        else unknown = true
      }
    }
    if (unknown) continue

    if (!refused && statuses.length > 0 && statuses.every((s) => s === 'rejected' || s === 'cancelled' || s === 'failed')) {
      // The bank closed every payment during the signing: nothing is left to sign again.
      const to: PaymentOrderBatchStatus = statuses.every((s) => s === 'rejected')
        ? 'rejected'
        : statuses.every((s) => s === 'cancelled')
          ? 'cancelled'
          : 'failed'
      const { error: closeError } = await writer
        .from('payment_order_batches')
        .update({ status: to })
        .eq('id', batch.id)
        .eq('company_id', batch.company_id)
        .eq('status', 'awaiting_signature')
        .eq('provider_authorisation_id', attempt)
      // Still waiting, so the next run closes it; reported so a write that keeps failing is seen.
      if (closeError) {
        result.errors += 1
        log.error('a signing the bank closed could not be closed', closeError, { batchId: batch.id, status: to })
      }
      continue
    }

    // A payment still reading unsigned never alone says nobody signed: a bank
    // may answer RCVD for minutes after a finalised BankID (crm desk #1267).
    // The BankID itself is asked.
    const signedPayment = statuses.some((s) => SIGNED.has(s))
    const party = orders[0] ? statusParty(orders[0], orgNumber, await psuOf(batch.id)) : null
    // The BankID read is one more call to the bank: out of time, the signing waits for the next run.
    if (!signedPayment && party && !limits.budget.allows()) {
      result.deferred += 1
      continue
    }
    const bankId = signedPayment || !party ? null : await bankIdProgress(provider, party, batch, attempt, orders, log, result)

    if (signedPayment || bankId?.state === 'finalised') {
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

    // Nobody signed and nobody can any more: the payments are cancelled at the
    // bank and the orders let go, as when the signing poll sees the BankID end
    // (endFailedSigning). An order whose cancel the bank does not confirm stays
    // submitted for a person. A BankID still open by the bank's word, or one
    // that cannot be read, is not known to be abandoned: the signing is left
    // for the next run, as an unreadable payment status is.
    if (bankId?.state === 'failed' && party) {
      // Ending it is one cancel at the bank per payment: not started once the
      // reads' budget is spent. An ending the platform cut short would leave
      // payments under a signing already failed, for a person.
      if (!limits.budget.allows()) {
        result.deferred += 1
        continue
      }
      const failure = { reason: 'SIGNING_ABANDONED', detail: { code: 'SIGNING_ABANDONED', provider_code: bankId.failureCode } }
      const stopped = await endFailedSigning(writer, { companyId: batch.company_id, userId: null, log }, provider, party, { batchId: batch.id, authorisationId: attempt }, orders, failure)
      if (stopped) result.abandoned += 1
      continue
    }

    // A bank that never reports the BankID failed would otherwise keep the
    // signing waiting, and be asked, on every run. Past
    // UNANSWERED_SIGNING_MINUTES no BankID is still open, but nothing is
    // cancelled on that inference: the orders go back to 'submitted' with
    // their payments at the bank, to sign again or cancel. Only the attempt
    // that was read is reset: a restart since then has its own id. A payment
    // the bank refused to read about ends here too: Signera igen and Avbryt
    // ask the bank with the person present, and a status the bank gives later
    // still moves the order forward.
    if (!startedBefore(batch, UNANSWERED_SIGNING_MINUTES)) continue
    const { data: reset } = await writer
      .from('payment_order_batches')
      .update({ status: 'created' })
      .eq('id', batch.id)
      .eq('company_id', batch.company_id)
      .eq('status', 'awaiting_signature')
      .eq('provider_authorisation_id', attempt)
      .select('id')
    if ((reset ?? []).length !== 1) continue
    const { error: ordersBackError } = await writer
      .from('payment_orders')
      .update({ status: 'submitted' })
      .eq('company_id', batch.company_id)
      .eq('batch_id', batch.id)
      .eq('status', 'awaiting_signature')
    if (ordersBackError) {
      // Orders left awaiting_signature under a reset signing are lost: this
      // pass reads only signings still waiting, and Signera igen needs them
      // submitted (crm#2085). The signing goes back to waiting for the same
      // attempt, so the next run does this again; one restarted or stopped
      // meanwhile is not touched.
      const { data: back, error: backError } = await writer
        .from('payment_order_batches')
        .update({ status: 'awaiting_signature' })
        .eq('id', batch.id)
        .eq('company_id', batch.company_id)
        .eq('status', 'created')
        .eq('provider_authorisation_id', attempt)
        .select('id')
      result.errors += 1
      log.error('orders of an abandoned signing could not go back to submitted', ordersBackError, {
        batchId: batch.id,
        retried: !backError && (back ?? []).length === 1,
      })
      continue
    }
    result.abandoned += 1
    await logPaymentOrderEvents(writer, [
      {
        company_id: batch.company_id,
        batch_id: batch.id,
        event_type: 'error',
        detail: { code: 'SIGNING_ABANDONED', bank_id: bankId?.state ?? 'unreadable', ...(refused ? { payment_status: 'refused' } : {}) },
      },
    ], log)
  }
}

function startedBefore(batch: PaymentOrderBatchRow, minutes: number): boolean {
  return batch.signing_started_at !== null && Date.parse(batch.signing_started_at) < Date.now() - minutes * 60_000
}

/**
 * Where a signing's current BankID stands, read unattended with the party its
 * payments were created with; null when it cannot be read (counted as an error).
 */
async function bankIdProgress(
  provider: PaymentInitiationProvider,
  party: PaymentPartyContext,
  batch: PaymentOrderBatchRow,
  authorisationId: string,
  orders: readonly PaymentOrderRow[],
  log: Logger,
  result: PaymentStatusSyncResult,
): Promise<SigningProgress | null> {
  const target = signingTargetOf(batch, orders)
  if (!target) return null
  try {
    return await provider.pollSigning(party, target, authorisationId, batch.signing_method ?? 'qr')
  } catch (err) {
    result.errors += 1
    log.warn('BankID of an unfinished signing could not be read', { batchId: batch.id, code: errorCode(err) })
    return null
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

export async function syncPaymentOrderStatuses(
  writer: SupabaseClient,
  log: Logger,
  budget: RunBudget = UNLIMITED_RUN,
  /** The two debit sweeps call no bank, so they may run past the reads' budget, on their own. */
  sweepBudget: RunBudget = budget,
): Promise<PaymentStatusSyncResult> {
  const result: PaymentStatusSyncResult = {
    checked: 0,
    moved: 0,
    markedUnknown: 0,
    released: 0,
    abandoned: 0,
    signedLate: 0,
    cancelledForClosedInvoice: 0,
    heldForPerson: 0,
    settledByDebit: 0,
    linkedByDebit: 0,
    forgottenIps: 0,
    deferred: 0,
    banksNotAnswering: 0,
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
  if (!(await hasPaymentInitiationProviders())) {
    await forgetIpsOfClosedSignings(writer, log, result)
    return { ...result, noProvider: true }
  }

  const orgNumbers = new Map<string, string | null>()
  const psuOf = batchPsuReader()
  const limits: RunLimits = { budget, banks: bankHealth() }
  await settleAbandonedSignings(writer, log, result, orgNumbers, psuOf, limits)

  // Every payment at the bank, oldest answer first, then the ones due a read
  // (isDueForStatusRead: all but those planned for a later day and answered
  // about within SCHEDULED_PAYMENT_READ_EVERY_MS), at most BATCH_LIMIT of
  // them. What a run does not reach keeps the oldest answer and is first in
  // the next. The rule is applied here and not in the query, so it has one
  // definition: the rows it leaves out are read from the database, which is
  // cheap, and not from the bank, which is what the run's time goes to.
  const now = new Date()
  const atTheBank = await fetchAllRows<PaymentOrderRow>(({ from, to }) =>
    writer
      .from('payment_orders')
      .select('*')
      .in('status', [...AT_THE_BANK])
      .not('provider_payment_id', 'is', null)
      .order('provider_status_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  const cancelAsked = await cancelAskedRecently(writer, log, atTheBank.filter((order) => !isDueForStatusRead(order, now)), now)
  const due = atTheBank.filter((order) => isDueForStatusRead(order, now, cancelAsked.has(order.id)))
  const orders = due.slice(0, BATCH_LIMIT)
  result.deferred += due.length - orders.length

  // Unsigned payments whose invoice no longer needs paying, and those already asked about once.
  const unsigned = orders.filter((o) => o.status === 'submitted')
  const unpayable = await unpayableOrders(writer, unsigned)
  const asked = await closedInvoiceCancelsAsked(writer, unsigned.filter((o) => unpayable.has(o.id)))

  const nextToRead = readingOrder(orders, limits.banks)
  let read = 0
  for (let order = nextToRead(); order; order = nextToRead()) {
    // Out of time: the rest keep their place at the front of the next run.
    if (!budget.allows()) {
      result.deferred += orders.length - read
      break
    }
    read += 1
    const provider = await getPaymentInitiationProvider(order.company_id)
    if (!provider || !order.provider_payment_id) continue
    if (!orgNumbers.has(order.company_id)) orgNumbers.set(order.company_id, await companyOrgNumber(writer, order.company_id))
    const orgNumber = orgNumbers.get(order.company_id)
    if (!orgNumber) continue
    result.checked += 1
    const party = statusParty(order, orgNumber, await psuOf(order.batch_id))
    let next: PaymentOrderStatus
    try {
      const state = await provider.getPaymentState(party, order.provider_payment_id, order.provider_payment_product ?? 'domestic')
      limits.banks.answered(order)
      next = await applyProviderState(writer, order, state, null, log)
      if (next !== order.status) result.moved += 1
    } catch (err) {
      result.errors += 1
      log.warn('payment status sync failed for one order', { orderId: order.id, code: errorCode(err) })
      if (isUnansweredRead(err)) limits.banks.unanswered(order)
      else if (err instanceof PaymentProviderError) limits.banks.answered(order)
      continue
    }
    if (next !== 'submitted' || !unpayable.has(order.id) || asked.has(`${order.id}:${order.provider_payment_id}`)) continue
    const outcome = await cancelForClosedInvoice(writer, { userId: null, log }, provider, party, order)
    if (outcome === 'cancelled' || outcome === 'released') result.cancelledForClosedInvoice += 1
    else if (outcome === 'held') result.heldForPerson += 1
  }

  result.banksNotAnswering = limits.banks.notAnswering()
  await settleExecutedOrdersByDebit(writer, log, result, sweepBudget)
  await linkOrdersWithoutInvoiceByDebit(writer, log, result, sweepBudget)
  await forgetIpsOfClosedSignings(writer, log, result)
  if (result.deferred > 0 || result.banksNotAnswering > 0) {
    log.warn('payment status sync left payments for the next run', { deferred: result.deferred, banksNotAnswering: result.banksNotAnswering })
  }
  return result
}

/**
 * The planned payments, of those given, that someone asked the bank to
 * cancel within CANCEL_FOLLOW_DAYS (a cancel_requested event). Read only
 * when a run has planned payments it would otherwise skip.
 */
async function cancelAskedRecently(writer: SupabaseClient, log: Logger, planned: readonly PaymentOrderRow[], now: Date): Promise<Set<string>> {
  if (planned.length === 0) return new Set()
  const since = new Date(now.getTime() - CANCEL_FOLLOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await writer
    .from('payment_order_events')
    .select('payment_order_id')
    .eq('event_type', 'cancel_requested')
    .gte('occurred_at', since)
    .not('payment_order_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(1000)
  // The lookup only makes some reads earlier: failing, it must not stop the reads themselves.
  if (error) {
    log.error('cancel requests of planned payments could not be read', error)
    return new Set()
  }
  const waiting = new Set(planned.map((order) => order.id))
  return new Set(((data ?? []) as Array<{ payment_order_id: string | null }>).flatMap((row) => (row.payment_order_id && waiting.has(row.payment_order_id) ? [row.payment_order_id] : [])))
}

/** The signings whose kept IP address the sweep looks at per run. */
const IP_SWEEP_LIMIT = 200

/**
 * The signer's IP address (payment_batch_psus.psu_ip_address) is personal
 * data kept only for the unattended reads and cancels of the signing's
 * payments: once none of its orders is at the bank (every one final,
 * released back to approved, or moved to a newer signing), nothing reads it
 * again and it is cleared. No order joins a signing after its start, so a
 * signing found closed stays closed. Additive like the debit sweeps: a
 * failure is one error line and the next run tries again; before the column
 * exists (between deploy and migration) there is nothing to clear.
 */
async function forgetIpsOfClosedSignings(writer: SupabaseClient, log: Logger, result: PaymentStatusSyncResult): Promise<void> {
  try {
    const { data, error } = await writer
      .from('payment_batch_psus')
      .select('batch_id')
      .not('psu_ip_address', 'is', null)
      .limit(IP_SWEEP_LIMIT)
    if (error) {
      const code = (error as { code?: unknown }).code
      if (code === '42703') return
      throw error
    }
    const kept = (Array.isArray(data) ? (data as Array<{ batch_id: string }>) : []).map((row) => row.batch_id)
    if (kept.length === 0) return
    // Every open order of those signings: a salary run's one signing may hold more than a page.
    const open = await fetchAllRows<{ batch_id: string | null }>(({ from, to }) =>
      writer
        .from('payment_orders')
        .select('batch_id')
        .in('batch_id', kept)
        .in('status', [...AT_THE_BANK])
        .order('id', { ascending: true })
        .range(from, to),
    )
    const stillAtBank = new Set(open.map((row) => row.batch_id))
    const closed = kept.filter((batchId) => !stillAtBank.has(batchId))
    if (closed.length === 0) return
    const { data: cleared, error: clearError } = await writer
      .from('payment_batch_psus')
      .update({ psu_ip_address: null })
      .in('batch_id', closed)
      .not('psu_ip_address', 'is', null)
      .select('batch_id')
    if (clearError) throw clearError
    result.forgottenIps += Array.isArray(cleared) ? cleared.length : 0
  } catch (err) {
    result.errors += 1
    log.error('signer IP addresses of closed signings could not be cleared', err as Error)
  }
}

/**
 * The one unbooked debit in the feed that is this order's: the order's amount
 * from its account in its execution window (findOrderForDebit decides, with
 * the same rules ingest applies). Two such debits and neither carrying the
 * order's end-to-end id is left for a person.
 */
async function unbookedDebitFor(
  writer: SupabaseClient,
  order: PaymentOrderRow,
): Promise<{ transaction: Transaction; confidence: number; basis: DebitMatchBasis } | null> {
  const { data, error } = await writer
    .from('open_bank_rows')
    .select('*')
    .eq('company_id', order.company_id)
    .eq('cash_account_id', order.cash_account_id)
    .eq('currency', order.currency)
    .eq('amount', -Number(order.amount))
    .is('supplier_invoice_id', null)
    .in('import_source', [...DEBIT_FEEDS])
    .gte('date', addDaysIso(order.requested_execution_date, -(DEBIT_WINDOW_DAYS_BEFORE + DEBIT_READ_SLACK_DAYS)))
    .lte('date', addDaysIso(order.requested_execution_date, DEBIT_WINDOW_DAYS_AFTER + DEBIT_READ_SLACK_DAYS))
    .limit(20)
  if (error) throw error
  const rows = Array.isArray(data) ? (data as Transaction[]) : []
  const matches = rows.flatMap((row) => {
    const match = findOrderForDebit(debitOfTransaction(row), [order])
    return match ? [{ transaction: row, confidence: match.confidence, basis: match.basis }] : []
  })
  if (matches.length === 1) return matches[0]
  const named = matches.filter((m) => m.basis === 'end_to_end_id')
  return named.length === 1 ? named[0] : null
}

/**
 * Executed orders nobody has settled, each booked with its own debit when
 * exactly one unbooked debit in the feed is it. Idempotent: the order and the
 * debit are read again right before booking (settleOrderWithDebit), and a
 * settled order leaves the read's filter.
 */
async function settleExecutedOrdersByDebit(writer: SupabaseClient, log: Logger, result: PaymentStatusSyncResult, budget: RunBudget): Promise<void> {
  let orders: PaymentOrderRow[]
  try {
    const since = new Date(Date.now() - EXECUTED_ORDER_SWEEP_DAYS * 86_400_000).toISOString()
    const { data, error } = await writer
      .from('payment_orders')
      .select('*')
      .eq('status', 'executed')
      .is('supplier_invoice_payment_id', null)
      .not('supplier_invoice_id', 'is', null)
      .not('provider_payment_id', 'is', null)
      .gte('executed_at', since)
      .order('executed_at', { ascending: true })
      .limit(BATCH_LIMIT)
    if (error) throw error
    // The read's own filter, applied again: a row another writer changed
    // between the read and here is left alone.
    orders = (Array.isArray(data) ? (data as PaymentOrderRow[]) : []).filter(
      (order) => order.status === 'executed' && isDebitSettleableOrder(order),
    )
  } catch (err) {
    // The sweep is additive to the status sync: its failure never undoes the
    // statuses applied above.
    result.errors += 1
    log.error('executed payment orders could not be read for the debit sweep', err as Error)
    return
  }

  for (const [index, order] of orders.entries()) {
    // Idempotent and read oldest first: what is left is settled by the next run.
    if (!budget.allows()) {
      result.deferred += orders.length - index
      break
    }
    try {
      const debit = await unbookedDebitFor(writer, order)
      if (!debit) continue
      const outcome = await settleOrderWithDebit(writer, {
        order,
        transaction: debit.transaction,
        confidence: debit.confidence,
        basis: debit.basis,
        log,
        writer,
      })
      if (outcome.ok) {
        result.settledByDebit += 1
        log.info('executed payment order settled with its debit', {
          orderId: order.id,
          transactionId: debit.transaction.id,
          basis: debit.basis,
          orderLinked: outcome.orderLinked,
        })
      } else {
        log.info('executed payment order left unsettled', {
          orderId: order.id,
          transactionId: debit.transaction.id,
          reason: outcome.reason,
          code: outcome.code ?? null,
        })
      }
    } catch (err) {
      result.errors += 1
      log.warn('debit sweep failed for one order', { orderId: order.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * The one debit in the feed, booked or not, that is this order's: the
 * order's amount from its account in its execution window, naming it
 * (findLinkableOrderForDebit decides among all of the company's linkable
 * orders, so a debit two of them could be is left alone). A debit another
 * order is linked to already is not a candidate.
 */
async function linkableDebitFor(
  writer: SupabaseClient,
  order: PaymentOrderRow,
  companyOrders: readonly PaymentOrderRow[],
): Promise<{ transaction: Transaction; basis: DebitLinkBasis } | null> {
  const { data, error } = await writer
    .from('transactions')
    .select('*')
    .eq('company_id', order.company_id)
    .eq('cash_account_id', order.cash_account_id)
    .eq('currency', order.currency)
    .eq('amount', -Number(order.amount))
    .is('supplier_invoice_id', null)
    .eq('is_ignored', false)
    .in('import_source', [...DEBIT_FEEDS])
    .gte('date', addDaysIso(order.requested_execution_date, -(DEBIT_WINDOW_DAYS_BEFORE + DEBIT_READ_SLACK_DAYS)))
    .lte('date', addDaysIso(order.requested_execution_date, DEBIT_WINDOW_DAYS_AFTER + DEBIT_READ_SLACK_DAYS))
    .limit(20)
  if (error) throw error
  const rows = Array.isArray(data) ? (data as Transaction[]) : []
  let matches = rows.flatMap((row) => {
    const link = findLinkableOrderForDebit(debitOfTransaction(row), companyOrders)
    return link && link.order.id === order.id ? [{ transaction: row, basis: link.basis }] : []
  })
  if (matches.length > 1) {
    // Another order's debit of the same shape (a salary run pays several
    // employees the same message) is not this one's.
    const { data: linkedData, error: linkedError } = await writer
      .from('payment_orders')
      .select('matched_transaction_id')
      .eq('company_id', order.company_id)
      .in('matched_transaction_id', matches.map((m) => m.transaction.id))
    if (linkedError) throw linkedError
    const linked = new Set(
      (Array.isArray(linkedData) ? (linkedData as Array<{ matched_transaction_id: string | null }>) : []).map((r) => r.matched_transaction_id),
    )
    matches = matches.filter((m) => !linked.has(m.transaction.id))
  }
  if (matches.length === 1) return matches[0]
  const named = matches.filter((m) => m.basis === 'end_to_end_id')
  return named.length === 1 ? named[0] : null
}

/**
 * Signed orders without an invoice (skattekonto, salary) nobody has linked,
 * each linked to its own debit when exactly one debit in the feed is it.
 * Books nothing. An order is read from the day before its execution date
 * (the earliest its debit may land) until EXECUTED_ORDER_SWEEP_DAYS after.
 * Idempotent: linkOrderToDebit reads the order, its signing and the debit
 * again, and a linked order leaves the read's filter.
 */
async function linkOrdersWithoutInvoiceByDebit(writer: SupabaseClient, log: Logger, result: PaymentStatusSyncResult, budget: RunBudget): Promise<void> {
  let orders: PaymentOrderRow[]
  try {
    const today = todayIsoStockholm()
    const { data, error } = await writer
      .from('payment_orders')
      .select('*')
      .in('status', [...DEBIT_LINKABLE_ORDER_STATUSES])
      .is('supplier_invoice_id', null)
      .is('matched_transaction_id', null)
      .not('provider_payment_id', 'is', null)
      .gte('requested_execution_date', addDaysIso(today, -EXECUTED_ORDER_SWEEP_DAYS))
      .lte('requested_execution_date', addDaysIso(today, DEBIT_WINDOW_DAYS_BEFORE))
      .order('requested_execution_date', { ascending: true })
      .limit(BATCH_LIMIT)
    if (error) throw error
    // The read's own filter, applied again in code, with the signings that
    // finished while the bank still answers RCVD.
    orders = (await withFinishedSignings(writer, Array.isArray(data) ? (data as PaymentOrderRow[]) : [])).filter(isDebitLinkableOrder)
  } catch (err) {
    result.errors += 1
    log.error('payment orders without an invoice could not be read for the debit sweep', err as Error)
    return
  }

  for (const [index, order] of orders.entries()) {
    if (!budget.allows()) {
      result.deferred += orders.length - index
      break
    }
    try {
      const debit = await linkableDebitFor(writer, order, orders.filter((o) => o.company_id === order.company_id))
      if (!debit) continue
      const outcome = await linkOrderToDebit(writer, { order, transaction: debit.transaction, basis: debit.basis, log, writer })
      if (outcome.ok) {
        result.linkedByDebit += 1
        log.info('payment order without an invoice linked to its debit', {
          orderId: order.id,
          transactionId: debit.transaction.id,
          basis: debit.basis,
          fromStatus: outcome.fromStatus,
        })
      } else {
        log.info('payment order without an invoice left unlinked', { orderId: order.id, transactionId: debit.transaction.id, reason: outcome.reason })
      }
    } catch (err) {
      result.errors += 1
      log.warn('debit link sweep failed for one order', { orderId: order.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
