import type { SupabaseClient } from '@supabase/supabase-js'
import { manualLink, ledgerLineAmountIn } from './bank-reconciliation'
import { logMatchEvent } from '@/lib/invoices/match-log'

/**
 * Confirm / reject persisted journal-entry match suggestions
 * (transactions.potential_journal_entry_id, written by the reconciliation
 * sweep's 0.75-0.89 band).
 *
 * Confirming is a reconciliation LINK, never a booking. Revalidated per pair
 * at click time, in this order: row still exists and is unlinked, suggestion
 * still present, suggested verifikat not already settled by another
 * transaction, the voucher's net movement on the settlement account still
 * agrees with the transaction's amount and direction (a suggestion computed
 * before an inline rattelse re-priced the bank leg must die here, not link),
 * and finally manualLink's own checks (entry posted, line on the settlement
 * account, optimistic lock on the row). Stale pairs are skipped and reported,
 * never failing the batch.
 *
 * The consumption check is read-then-act per request; two CONCURRENT requests
 * confirming different rows against the same verifikat can both pass it. The
 * sibling-clear trigger closes the window after the first commit, and a
 * double-settled voucher still surfaces as a non-zero difference on the
 * Bankavstamning status card, but within a single request the sequential
 * re-fetch is the real guarantee.
 */

export type SuggestionSkipReason =
  | 'not_found'
  | 'no_suggestion'
  | 'already_linked'
  | 'voucher_consumed'
  | 'amount_mismatch'
  | 'link_failed'

export interface SuggestionActionResult {
  confirmed: string[]
  rejected: string[]
  skipped: Array<{ transactionId: string; reason: SuggestionSkipReason; message?: string }>
}

interface SuggestionRow {
  id: string
  amount: number | string | null
  currency: string | null
  journal_entry_id: string | null
  potential_journal_entry_id: string | null
  potential_match_method: string | null
  potential_match_confidence: number | string | null
  cash_account_id: string | null
}

async function fetchSuggestionRow(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<SuggestionRow | null> {
  const { data } = await supabase
    .from('transactions')
    .select(
      'id, amount, currency, journal_entry_id, potential_journal_entry_id, potential_match_method, potential_match_confidence, cash_account_id',
    )
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  return (data as SuggestionRow | null) ?? null
}

/**
 * Resolve the settlement account manualLink must validate the voucher line
 * against. Rows with a cash_account_id use that account's ledger_account. Rows
 * WITHOUT one were swept under the PRIMARY cash account's scope
 * (includeUnassigned), so confirmation must resolve the same way: hard-coding
 * '1930' made every unassigned-row suggestion unconfirmable in a company whose
 * primary account is e.g. 1920 Plusgiro. '1930' remains only the final
 * fallback for companies with no cash_accounts rows at all.
 */
async function resolveSettlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null,
): Promise<string> {
  const query = supabase.from('cash_accounts').select('ledger_account').eq('company_id', companyId)
  const { data } = cashAccountId
    ? await query.eq('id', cashAccountId).maybeSingle()
    : await query.eq('is_primary', true).maybeSingle()
  return (data?.ledger_account as string | undefined) ?? '1930'
}

/** Fuzzy band tolerance: the widest amount slack any persisted suggestion was
 *  created under (auto_fuzzy, +-0.01), plus float headroom. */
const CONFIRM_AMOUNT_TOLERANCE = 0.011

/**
 * The suggested voucher's net movement on the settlement account must still
 * agree with the transaction, in the transaction's own currency. Returns null
 * when it does; a skip reason message when it does not or cannot be verified
 * (no comparable amount = no honest link, per the determinism rule).
 */
async function verifySuggestedAmount(
  supabase: SupabaseClient,
  tx: SuggestionRow,
  accountNumber: string,
): Promise<string | null> {
  const { data: lines } = await supabase
    .from('journal_entry_lines')
    .select('debit_amount, credit_amount, currency, amount_in_currency')
    .eq('journal_entry_id', tx.potential_journal_entry_id)
    .eq('account_number', accountNumber)

  if (!lines || lines.length === 0) {
    return `Verifikationen saknar rad på ${accountNumber}`
  }
  const txCurrency = tx.currency ?? 'SEK'
  let movement = 0
  for (const line of lines) {
    const amount = ledgerLineAmountIn(line, txCurrency)
    if (amount === null) {
      return 'Verifikationens belopp kan inte jämföras i transaktionens valuta'
    }
    movement += amount
  }
  const txAmount = Number(tx.amount)
  if (!Number.isFinite(txAmount)) return 'Transaktionens belopp kunde inte läsas'
  if (Math.abs(Math.abs(txAmount) - Math.abs(movement)) > CONFIRM_AMOUNT_TOLERANCE) {
    return 'Beloppet stämmer inte längre med verifikationen'
  }
  if (Math.sign(txAmount) !== Math.sign(movement)) {
    return 'Riktningen stämmer inte längre med verifikationen'
  }
  return null
}

export async function confirmJournalEntrySuggestions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionIds: string[],
): Promise<SuggestionActionResult> {
  const result: SuggestionActionResult = { confirmed: [], rejected: [], skipped: [] }

  // Sequential on purpose: each pair is re-fetched at its turn, so when two
  // batch rows suggest the SAME verifikat the first confirm consumes it and the
  // second reads its (trigger-cleared) suggestion as gone instead of racing.
  for (const transactionId of transactionIds) {
    const tx = await fetchSuggestionRow(supabase, companyId, transactionId)
    if (!tx) {
      result.skipped.push({ transactionId, reason: 'not_found' })
      continue
    }
    if (tx.journal_entry_id) {
      result.skipped.push({ transactionId, reason: 'already_linked' })
      continue
    }
    if (!tx.potential_journal_entry_id) {
      result.skipped.push({ transactionId, reason: 'no_suggestion' })
      continue
    }

    // Explicit consumption check on top of the invalidation trigger: a
    // verifikat another transaction already settles is not offered twice.
    // (manualLink deliberately allows N:1 for the manual instalments case;
    // bulk-confirming a suggestion is not that case.)
    const { data: consumers } = await supabase
      .from('transactions')
      .select('id')
      .eq('company_id', companyId)
      .eq('journal_entry_id', tx.potential_journal_entry_id)
      .limit(1)
    if (consumers && consumers.length > 0) {
      result.skipped.push({ transactionId, reason: 'voucher_consumed' })
      continue
    }

    const accountNumber = await resolveSettlementAccount(supabase, companyId, tx.cash_account_id)

    // Amount/direction revalidation: a suggestion is a snapshot, and the
    // voucher's bank leg can legally change after it was computed (inline
    // rattelse strike-and-replace keeps status 'posted', so no invalidation
    // trigger fires). Never link on a stale snapshot.
    const amountProblem = await verifySuggestedAmount(supabase, tx, accountNumber)
    if (amountProblem) {
      result.skipped.push({ transactionId, reason: 'amount_mismatch', message: amountProblem })
      continue
    }

    const linkResult = await manualLink(
      supabase,
      companyId,
      transactionId,
      tx.potential_journal_entry_id,
      userId,
      accountNumber,
    )
    if (!linkResult.success) {
      result.skipped.push({
        transactionId,
        reason: 'link_failed',
        message: linkResult.error,
      })
      continue
    }

    result.confirmed.push(transactionId)
    // Awaited: on serverless an unawaited promise can be frozen when the
    // response returns, silently dropping the audit row. logMatchEvent itself
    // never throws.
    await logMatchEvent(supabase, userId, transactionId, 'linked_to_existing_voucher', {
      matchMethod: tx.potential_match_method ?? undefined,
      matchConfidence:
        tx.potential_match_confidence !== null
          ? Number(tx.potential_match_confidence)
          : undefined,
      newState: {
        journal_entry_id: tx.potential_journal_entry_id,
        reconciliation_method: 'manual',
        confirmed_suggestion: true,
      },
    })
  }

  return result
}

export async function rejectJournalEntrySuggestions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  transactionIds: string[],
): Promise<SuggestionActionResult> {
  const result: SuggestionActionResult = { confirmed: [], rejected: [], skipped: [] }

  for (const transactionId of transactionIds) {
    const tx = await fetchSuggestionRow(supabase, companyId, transactionId)
    if (!tx) {
      result.skipped.push({ transactionId, reason: 'not_found' })
      continue
    }
    if (!tx.potential_journal_entry_id) {
      result.skipped.push({ transactionId, reason: 'no_suggestion' })
      continue
    }

    const { error } = await supabase
      .from('transactions')
      .update({
        potential_journal_entry_id: null,
        potential_match_method: null,
        potential_match_confidence: null,
      })
      .eq('id', transactionId)
      .eq('company_id', companyId)

    if (error) {
      result.skipped.push({ transactionId, reason: 'link_failed', message: error.message })
      continue
    }

    result.rejected.push(transactionId)
    await logMatchEvent(supabase, userId, transactionId, 'suggestion_cleared', {
      previousState: {
        potential_journal_entry_id: tx.potential_journal_entry_id,
        potential_match_method: tx.potential_match_method,
        potential_match_confidence: tx.potential_match_confidence,
      },
    })
  }

  return result
}
