/**
 * Match an income bank row to the ROT/RUT begäran Skatteverket paid with it.
 *
 * One writer for two callers: the dashboard route
 * POST /api/transactions/[id]/match-rot-rut-payout and the MCP commit
 * executor for settle_rot_rut_payout (gnubok_settle_rot_rut_payout). Both
 * used to need the same pre-flight (income, SEK, not already booked, the
 * row's own cash account) before the settle service; keeping it here means a
 * guard added for one surface is a guard on the other.
 *
 * Amount, date and bank account come from the bank row and the row is linked
 * to the voucher in the same call, so the payout can never be booked twice
 * (once by settle, once by categorising the bank row). Several begäran in
 * one transfer (#2239) book ONE voucher with one 1513 credit per begäran.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import {
  settleRotRutPayoutRequest,
  settleRotRutPayoutRequestSet,
  type SettleRotRutPayoutErrorCode,
  type SettledRotRutPayoutRequest,
} from '@/lib/invoices/rot-rut-settle'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'

export type MatchRotRutPayoutErrorCode =
  | SettleRotRutPayoutErrorCode
  | 'TX_CATEGORIZE_TX_NOT_FOUND'
  | 'ROT_RUT_MATCH_NOT_INCOME'
  | 'ROT_RUT_MATCH_CURRENCY'
  | 'ROT_RUT_MATCH_TX_ALREADY_LINKED'

export type MatchRotRutPayoutOutcome =
  | {
      ok: true
      journalEntryId: string
      amount: number
      fullyPaid: boolean
      /** Every begäran the voucher settled (one for the single shape). */
      requests: SettledRotRutPayoutRequest[]
      /** The single begäran, when exactly one was matched. */
      request?: SettledRotRutPayoutRequest
    }
  | { ok: false; kind: 'code'; code: MatchRotRutPayoutErrorCode; details?: Record<string, unknown> }
  | { ok: false; kind: 'error'; error: unknown; stage: 'fetch' | 'book' | 'update' }

export interface MatchRotRutPayoutParams {
  transactionId: string
  /** 1..n begäran; duplicates collapse. */
  requestIds: string[]
}

export async function matchTransactionToRotRutPayout(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: MatchRotRutPayoutParams,
  log: Logger,
): Promise<MatchRotRutPayoutOutcome> {
  const payoutRequestIds = [...new Set(params.requestIds)]
  if (payoutRequestIds.length === 0) {
    return { ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' }
  }

  // transaction_voucher_links rides along: a row bulk-booked into a
  // samlingsverifikat carries journal_entry_id = NULL and must still refuse.
  const { data: transactionRow, error: fetchTxError } = await supabase
    .from('transactions')
    .select(
      'id, date, amount, currency, journal_entry_id, cash_account_id, transaction_voucher_links(journal_entry_id, role)',
    )
    .eq('id', params.transactionId)
    .eq('company_id', companyId)
    .single()

  if (fetchTxError || !transactionRow) {
    return { ok: false, kind: 'code', code: 'TX_CATEGORIZE_TX_NOT_FOUND' }
  }
  const { transaction_voucher_links: junctionLinks, ...transaction } = transactionRow as {
    id: string
    date: string
    amount: number
    currency: string | null
    journal_entry_id: string | null
    cash_account_id: string | null
    transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
  }

  if (!(transaction.amount > 0)) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_MATCH_NOT_INCOME',
      details: { amount: transaction.amount },
    }
  }

  if ((transaction.currency || 'SEK').toUpperCase() !== 'SEK') {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_MATCH_CURRENCY',
      details: { currency: transaction.currency },
    }
  }

  // Only a LIVE (posted) pointer or a bank_line junction row blocks: a
  // pointer left behind by a storno reads as "utan koppling" in the UI and
  // must stay matchable (same predicate as link-journal-entry, issue #988).
  if (
    hasBankLineJunctionRow(junctionLinks) ||
    (await hasLiveJournalEntryLink(supabase, companyId, transaction.journal_entry_id))
  ) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_MATCH_TX_ALREADY_LINKED',
      details: { existingJournalEntryId: transaction.journal_entry_id },
    }
  }

  // Debit the cash account THIS transaction belongs to, never a company-wide
  // default (mirrors match-supplier-invoice).
  const bankAccount = await resolveSettlementAccount(
    supabase,
    companyId,
    transaction.cash_account_id,
    log,
  )

  // Shared by both shapes: amount, date and account come from the bank row;
  // the link CAS locks on the pointer read above (null for a free row, or
  // the stale pointer of a reversed entry the guard let through).
  const settleParams = {
    paymentDate: transaction.date,
    amount: transaction.amount,
    bankAccount,
    transactionId: params.transactionId,
    previousJournalEntryId: transaction.journal_entry_id,
  }

  if (payoutRequestIds.length === 1) {
    const outcome = await settleRotRutPayoutRequest(supabase, userId, companyId, {
      requestId: payoutRequestIds[0],
      ...settleParams,
    })
    if (!outcome.ok) return outcome
    return {
      ok: true,
      journalEntryId: outcome.journalEntryId,
      amount: outcome.amount,
      fullyPaid: outcome.fullyPaid,
      requests: [outcome.request],
      request: outcome.request,
    }
  }

  const outcome = await settleRotRutPayoutRequestSet(supabase, userId, companyId, {
    requestIds: payoutRequestIds,
    ...settleParams,
  })
  if (!outcome.ok) return outcome
  return {
    ok: true,
    journalEntryId: outcome.journalEntryId,
    amount: outcome.amount,
    fullyPaid: true,
    requests: outcome.requests,
  }
}
