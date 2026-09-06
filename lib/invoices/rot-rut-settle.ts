/**
 * Settle a ROT/RUT begäran: book Skatteverkets utbetalning and, optionally,
 * link the bank transaction that carried it.
 *
 *   Debit  19xx bank account (default 1930)  [amount]
 *   Credit 1513 Skattereduktion rot/rut      [amount]
 *
 * Shared between two callers:
 *   - REST: app/api/rot-rut/payout-requests/[id]/settle/route.ts
 *     (headless settle: amount/date/bank account supplied by the caller)
 *   - REST: app/api/transactions/[id]/match-rot-rut-payout/route.ts
 *     (bank-row match: amount/date/bank account come from the transaction,
 *     and the row is linked to the settlement voucher in the same call)
 *
 * Skatteverket decides per begäran but pays everything it decided that day
 * in ONE transfer (#2239). settleRotRutPayoutRequestSet books that bundle as
 * one voucher (one bank leg, one 1513 leg per begäran) and marks every
 * begäran settled by it, through the same writer and the same tail as the
 * single path; a bundle is always booked at exactly the decided sums.
 *
 * The journal entry IS the accounting record: engine failure blocks the whole
 * operation. Everything after the voucher is best-effort-with-loud-logging,
 * never an unbook (the voucher is immutable per BFL).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createRotRutPayoutEntry,
  createRotRutPayoutSetEntry,
} from '@/lib/bookkeeping/rot-rut-entries'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/rot-rut-settle')

export interface SettleRotRutPayoutParams {
  requestId: string
  paymentDate: string
  /** Defaults to decided_total ?? requested_total. */
  amount?: number
  /** BAS 19xx account the payout landed on. Defaults to 1930 in the engine. */
  bankAccount?: string
  /**
   * Bank transaction that carried the payout. When set, the row is linked to
   * the settlement voucher (journal_entry_id) and its match hints are cleared.
   * The caller must have verified the row is unbooked and belongs to the
   * company; this function re-checks with an optimistic lock on
   * journal_entry_id IS NULL.
   */
  transactionId?: string
  /**
   * The transaction's journal_entry_id as the caller read it: null for a free
   * row, or the STALE id of a reversed/cancelled entry the route judged not
   * live (issue #988). The link CAS locks on exactly that value, so a stale
   * pointer can be overwritten while a concurrent live link still turns the
   * write into a no-op (same contract as link-journal-entry.ts).
   */
  previousJournalEntryId?: string | null
}

export interface SettledRotRutPayoutRequest {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: string
  requested_total: number | string
  decided_total: number | string | null
  decided_at: string | null
  settlement_journal_entry_id: string | null
}

export type SettleRotRutPayoutErrorCode =
  | 'ROT_RUT_REQUEST_NOT_FOUND'
  | 'ROT_RUT_SETTLE_INVALID_STATE'
  | 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS'
  | 'ROT_RUT_SETTLE_SET_AMOUNT'
  | 'ROT_RUT_SETTLE_RACE'
  | 'ROT_RUT_MATCH_TX_LINK_FAILED'

export type SettleRotRutPayoutOutcome =
  | {
      ok: true
      request: SettledRotRutPayoutRequest
      journalEntryId: string
      amount: number
      fullyPaid: boolean
    }
  | { ok: false; kind: 'code'; code: SettleRotRutPayoutErrorCode; details?: Record<string, unknown> }
  /** A raw Supabase/engine error the route maps through errorResponse(). */
  | { ok: false; kind: 'error'; error: unknown; stage: 'fetch' | 'book' | 'update' }

const SETTLED_REQUEST_COLUMNS =
  'id, name, deduction_type, status, requested_total, decided_total, decided_at, settlement_journal_entry_id'

interface PayoutRequestRow {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: string
  requested_total: number | string
  decided_total: number | string | null
  decided_at: string | null
  settlement_journal_entry_id: string | null
}

/** Mirrors the settle guard: no settlement voucher yet and not cancelled/rejected. */
function isSettleable(request: PayoutRequestRow): boolean {
  return (
    !request.settlement_journal_entry_id && !['cancelled', 'rejected'].includes(request.status)
  )
}

/**
 * CAS on settlement_journal_entry_id IS NULL: two concurrent settles (two
 * same-amount bank rows, or a headless call racing a match) must not both
 * attach and credit 1513 twice. Returns the updated row, null when the lock
 * was lost, or the raw error.
 */
async function attachSettlementVoucher(
  supabase: SupabaseClient,
  companyId: string,
  request: PayoutRequestRow,
  journalEntryId: string,
  amount: number,
  fullyPaid: boolean,
): Promise<{ updated: SettledRotRutPayoutRequest | null; error: unknown }> {
  const update: Record<string, unknown> = {
    settlement_journal_entry_id: journalEntryId,
    status: fullyPaid ? 'paid' : 'partially_paid',
    decided_total: request.decided_total ?? amount,
  }
  if (!request.decided_at) {
    update.decided_at = new Date().toISOString()
  }
  const { data: updated, error } = await supabase
    .from('rot_rut_payout_requests')
    .update(update)
    .eq('company_id', companyId)
    .eq('id', request.id)
    .is('settlement_journal_entry_id', null)
    .select(SETTLED_REQUEST_COLUMNS)
    .maybeSingle()
  return { updated: (updated as SettledRotRutPayoutRequest | null) ?? null, error }
}

/**
 * Link the bank row to the settlement voucher with an optimistic lock on the
 * pointer the route read (null for a free row, or the stale id of a reversed
 * entry, issue #988). A concurrent booking between that read and this write
 * changes the pointer, so the write matches 0 rows instead of silently
 * overwriting it (same CAS contract as link-journal-entry.ts). Returns false
 * when the link did not land; the voucher stands either way.
 */
async function linkTransactionToSettlement(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: {
    transactionId: string
    previousJournalEntryId: string | null
    journalEntryId: string
    logState: Record<string, unknown>
    logContext: Record<string, unknown>
  },
): Promise<boolean> {
  const txUpdate = supabase
    .from('transactions')
    .update({
      journal_entry_id: params.journalEntryId,
      is_business: true,
      category: 'income_other',
      potential_invoice_id: null,
      potential_supplier_invoice_id: null,
      potential_rot_rut_payout_request_id: null,
      // The match supersedes any prior reconciliation link (mirrors
      // match-invoice): a literal null keeps the phantom-column scanner
      // able to verify the column set.
      reconciliation_method: null,
    })
    .eq('id', params.transactionId)
    .eq('company_id', companyId)
  const { data: linkedRows, error: linkError } = await (params.previousJournalEntryId === null
    ? txUpdate.is('journal_entry_id', null)
    : txUpdate.eq('journal_entry_id', params.previousJournalEntryId)
  ).select('id')

  if (linkError || !linkedRows || linkedRows.length === 0) {
    // Voucher booked and request settled, but the bank row is not linked:
    // the user can still attach it via "Matcha mot befintlig verifikation".
    // Say exactly that instead of pretending the match went through.
    log.error('rot/rut payout settled but transaction link failed', linkError ?? undefined, {
      ...params.logContext,
      journalEntryId: params.journalEntryId,
      transactionId: params.transactionId,
      reason: linkError?.message ?? 'optimistic lock returned 0 rows',
    })
    return false
  }

  // An utbetalningsbesked pinned on the bank row becomes the voucher's
  // underlag (BFL 5 kap 6 §), as every other booking path does.
  await propagateUnderlagForBookedTransaction(
    supabase,
    companyId,
    params.transactionId,
    params.journalEntryId,
  )

  await logMatchEvent(supabase, userId, params.transactionId, 'matched', {
    matchConfidence: 1.0,
    matchMethod: 'rot_rut_payout_manual_confirm',
    newState: { journal_entry_id: params.journalEntryId, ...params.logState },
  })
  return true
}

/** A fully paid begäran mirrors requested_amount onto every item's decided_amount. */
async function mirrorDecidedAmounts(supabase: SupabaseClient, requestId: string): Promise<void> {
  const { data: items, error: itemsFetchError } = await supabase
    .from('rot_rut_payout_request_items')
    .select('id, requested_amount')
    .eq('request_id', requestId)
  if (itemsFetchError) {
    log.warn('failed to fetch items for decided_amount mirror', {
      payoutRequestId: requestId,
      message: itemsFetchError.message,
    })
  }
  for (const item of items ?? []) {
    const { error: mirrorError } = await supabase
      .from('rot_rut_payout_request_items')
      .update({ decided_amount: item.requested_amount })
      .eq('id', item.id)
    if (mirrorError) {
      log.warn('failed to mirror decided_amount onto item', {
        itemId: item.id,
        message: mirrorError.message,
      })
    }
  }
}

export async function settleRotRutPayoutRequest(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: SettleRotRutPayoutParams,
): Promise<SettleRotRutPayoutOutcome> {
  const { data: payoutRequest, error: fetchError } = await supabase
    .from('rot_rut_payout_requests')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', params.requestId)
    .maybeSingle()

  if (fetchError) {
    return { ok: false, kind: 'error', error: fetchError, stage: 'fetch' }
  }
  if (!payoutRequest) {
    return { ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' }
  }

  if (!isSettleable(payoutRequest)) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_INVALID_STATE',
      details: {
        status: payoutRequest.status,
        already_settled: !!payoutRequest.settlement_journal_entry_id,
      },
    }
  }

  const amount =
    params.amount ?? Number(payoutRequest.decided_total ?? payoutRequest.requested_total)

  // A partial settlement must follow a recorded beslut: without this guard a
  // settle with amount < requested_total on an undecided request would flip
  // it to partially_paid while bypassing the PATCH lifecycle rule that
  // partially_paid requires decided_total: the beslut would never be
  // recorded and later PATCH calls would be blocked by ALLOWED_TRANSITIONS.
  if (amount < Number(payoutRequest.requested_total) && payoutRequest.decided_total == null) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_INVALID_STATE',
      details: {
        status: payoutRequest.status,
        reason:
          'Delutbetalning kräver att Skatteverkets beslut registreras först (decided_total via PATCH).',
      },
    }
  }

  // Never book more than Skatteverket can owe on this begäran: a larger bank
  // row (a moms/skattekonto refund, two begäran in one transfer) would drive
  // 1513 into a credit balance and rewrite decided_total to the bank amount.
  // Two begäran in one transfer is the set path (settleRotRutPayoutRequestSet);
  // anything else the user books another way. This path stays exact.
  const expectedAmount = roundOre(Number(payoutRequest.decided_total ?? payoutRequest.requested_total))
  if (amount > expectedAmount + 0.005) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_AMOUNT_EXCEEDS',
      details: { amount, expected_amount: expectedAmount, status: payoutRequest.status },
    }
  }

  // The voucher is the accounting record: engine failure must block.
  let journalEntryId: string
  try {
    const entry = await createRotRutPayoutEntry(supabase, companyId, userId, {
      requestId: payoutRequest.id,
      requestName: payoutRequest.name,
      deductionType: payoutRequest.deduction_type,
      paymentDate: params.paymentDate,
      amount,
      bankAccount: params.bankAccount,
    })
    journalEntryId = entry.id
  } catch (engineError) {
    return { ok: false, kind: 'error', error: engineError, stage: 'book' }
  }

  const fullyPaid = amount >= Number(payoutRequest.requested_total)
  const { updated, error: updateError } = await attachSettlementVoucher(
    supabase,
    companyId,
    payoutRequest,
    journalEntryId,
    amount,
    fullyPaid,
  )

  if (updateError) {
    // The voucher exists (immutable per BFL) but the request row didn't
    // absorb the link: surface loudly, do NOT try to unbook.
    log.error('rot/rut payout entry booked but request update failed', updateError as Error, {
      journalEntryId,
      payoutRequestId: params.requestId,
    })
    return { ok: false, kind: 'error', error: updateError, stage: 'update' }
  }
  if (!updated) {
    // The loser's voucher already exists (immutable per BFL): say so loudly
    // rather than overwrite the winner.
    log.error('rot/rut payout entry booked but request was settled concurrently', undefined, {
      journalEntryId,
      payoutRequestId: params.requestId,
    })
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_RACE',
      details: { journal_entry_id: journalEntryId, request_id: params.requestId },
    }
  }

  if (params.transactionId) {
    const linked = await linkTransactionToSettlement(supabase, userId, companyId, {
      transactionId: params.transactionId,
      previousJournalEntryId: params.previousJournalEntryId ?? null,
      journalEntryId,
      logState: {
        rot_rut_payout_request_id: params.requestId,
        request_status: updated.status,
        amount,
      },
      logContext: { payoutRequestId: params.requestId },
    })
    if (!linked) {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_MATCH_TX_LINK_FAILED',
        details: { journal_entry_id: journalEntryId, request_id: params.requestId },
      }
    }
  }

  if (fullyPaid) {
    await mirrorDecidedAmounts(supabase, params.requestId)
  }

  // The request is settled: every OTHER bank row still hinting at it is a dead
  // suggestion. This row's own hint was cleared by the link update above.
  await clearSettledInvoiceSuggestions(
    supabase,
    companyId,
    'rot_rut_payout_request',
    params.requestId,
    { exceptTransactionId: params.transactionId ?? null },
  )

  log.info('rot/rut payout settled', {
    userId,
    payoutRequestId: params.requestId,
    journalEntryId,
    amount,
    fullyPaid,
    transactionId: params.transactionId ?? null,
  })

  return {
    ok: true,
    request: updated,
    journalEntryId,
    amount,
    fullyPaid,
  }
}

export interface SettleRotRutPayoutSetParams {
  /** The begäran Skatteverket paid together, in booking order. */
  requestIds: string[]
  paymentDate: string
  /** The bank row amount: must equal the requests' expected payouts to the öre. */
  amount: number
  /** BAS 19xx account the payout landed on. Defaults to 1930 in the engine. */
  bankAccount?: string
  /** See SettleRotRutPayoutParams.transactionId. */
  transactionId?: string
  /** See SettleRotRutPayoutParams.previousJournalEntryId. */
  previousJournalEntryId?: string | null
}

export type SettleRotRutPayoutSetOutcome =
  | {
      ok: true
      requests: SettledRotRutPayoutRequest[]
      journalEntryId: string
      amount: number
    }
  | { ok: false; kind: 'code'; code: SettleRotRutPayoutErrorCode; details?: Record<string, unknown> }
  | { ok: false; kind: 'error'; error: unknown; stage: 'fetch' | 'book' | 'update' }

/**
 * Settle several begäran with ONE bank transfer: one voucher (debit 19xx for
 * the transfer, one 1513 credit per begäran), every request pointed at it,
 * the row linked once. Refuses before booking anything unless every request
 * is open and unsettled and the expected payouts sum to the transfer
 * exactly: Skatteverket pays the decided sums, so a bundle never books
 * anything but decided_total ?? requested_total per begäran. A begäran
 * Skatteverket decided at less than requested is a legitimate member (its
 * leg is the beslut) and ends up partially_paid with its items untouched,
 * exactly as the single path leaves it for manual handling; the others
 * complete as paid.
 */
export async function settleRotRutPayoutRequestSet(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: SettleRotRutPayoutSetParams,
): Promise<SettleRotRutPayoutSetOutcome> {
  const requestIds = [...new Set(params.requestIds)]
  if (requestIds.length === 0) {
    return { ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' }
  }

  const { data: rows, error: fetchError } = await supabase
    .from('rot_rut_payout_requests')
    .select('*')
    .eq('company_id', companyId)
    .in('id', requestIds)
  if (fetchError) {
    return { ok: false, kind: 'error', error: fetchError, stage: 'fetch' }
  }
  const byId = new Map(((rows ?? []) as PayoutRequestRow[]).map((row) => [row.id, row] as const))
  const missing = requestIds.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_REQUEST_NOT_FOUND',
      details: { request_ids: missing },
    }
  }
  // Booking order follows the caller's order (largest first from the matcher).
  const requests = requestIds.map((id) => byId.get(id)!)

  const blocked = requests.find((request) => !isSettleable(request))
  if (blocked) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_INVALID_STATE',
      details: {
        request_id: blocked.id,
        status: blocked.status,
        already_settled: !!blocked.settlement_journal_entry_id,
      },
    }
  }

  const legs = requests.map((request) => {
    const amount = roundOre(Number(request.decided_total ?? request.requested_total))
    return {
      request,
      amount,
      // Same rule as the single path: only a leg covering the requested total
      // completes the begäran; a recorded lower beslut stays partially_paid.
      fullyPaid: amount >= Number(request.requested_total),
    }
  })
  const expectedTotal = roundOre(legs.reduce((sum, leg) => sum + leg.amount, 0))
  const amount = roundOre(params.amount)
  if (Math.abs(amount - expectedTotal) > 0.005) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_SET_AMOUNT',
      details: { amount, expected_total: expectedTotal, request_ids: requestIds },
    }
  }

  // The voucher is the accounting record: engine failure must block.
  let journalEntryId: string
  try {
    const entry = await createRotRutPayoutSetEntry(supabase, companyId, userId, {
      paymentDate: params.paymentDate,
      bankAccount: params.bankAccount,
      legs: legs.map((leg) => ({
        requestId: leg.request.id,
        requestName: leg.request.name,
        deductionType: leg.request.deduction_type,
        amount: leg.amount,
      })),
    })
    journalEntryId = entry.id
  } catch (engineError) {
    return { ok: false, kind: 'error', error: engineError, stage: 'book' }
  }

  // Every request absorbs the same voucher under its own CAS. A lost lock
  // means that begäran was settled concurrently by another voucher: this
  // voucher then credits 1513 once too often for it. Say so loudly (the
  // details name the requests that did attach); never unbook.
  const settled: SettledRotRutPayoutRequest[] = []
  for (const leg of legs) {
    const { updated, error: updateError } = await attachSettlementVoucher(
      supabase,
      companyId,
      leg.request,
      journalEntryId,
      leg.amount,
      leg.fullyPaid,
    )
    if (updateError) {
      log.error('rot/rut payout set entry booked but request update failed', updateError as Error, {
        journalEntryId,
        payoutRequestId: leg.request.id,
        settledRequestIds: settled.map((request) => request.id),
      })
      return { ok: false, kind: 'error', error: updateError, stage: 'update' }
    }
    if (!updated) {
      log.error('rot/rut payout set entry booked but a request was settled concurrently', undefined, {
        journalEntryId,
        payoutRequestId: leg.request.id,
        settledRequestIds: settled.map((request) => request.id),
      })
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_SETTLE_RACE',
        details: {
          journal_entry_id: journalEntryId,
          request_id: leg.request.id,
          settled_request_ids: settled.map((request) => request.id),
        },
      }
    }
    settled.push(updated)
  }

  if (params.transactionId) {
    const linked = await linkTransactionToSettlement(supabase, userId, companyId, {
      transactionId: params.transactionId,
      previousJournalEntryId: params.previousJournalEntryId ?? null,
      journalEntryId,
      logState: {
        rot_rut_payout_request_ids: requestIds,
        request_statuses: settled.map((request) => request.status),
        amount,
      },
      logContext: { payoutRequestIds: requestIds },
    })
    if (!linked) {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_MATCH_TX_LINK_FAILED',
        details: { journal_entry_id: journalEntryId, request_ids: requestIds },
      }
    }
  }

  // Every settled begäran carries a voucher now and is no longer matchable,
  // so its sibling hints die either way; the item mirror is for the fully
  // paid ones only (a partial beslut keeps its item amounts for the manual
  // follow-up, as on the single path).
  for (const leg of legs) {
    if (leg.fullyPaid) await mirrorDecidedAmounts(supabase, leg.request.id)
    await clearSettledInvoiceSuggestions(supabase, companyId, 'rot_rut_payout_request', leg.request.id, {
      exceptTransactionId: params.transactionId ?? null,
    })
  }

  log.info('rot/rut payout set settled', {
    userId,
    payoutRequestIds: requestIds,
    journalEntryId,
    amount,
    transactionId: params.transactionId ?? null,
  })

  return { ok: true, requests: settled, journalEntryId, amount }
}
