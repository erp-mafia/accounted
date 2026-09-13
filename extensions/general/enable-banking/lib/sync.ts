import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccountBalance } from './api-client'
import { selectBankFeedAdapter } from './bank-feed'
import { historyWindowDays } from './history-window'
import type { BookedBankTransaction } from '@/lib/bank-feed/port'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { ingestTransactions as defaultIngest } from '@/lib/transactions/ingest'
import { buildStableExternalIds, FALLBACK_DESCRIPTION } from '@/lib/transactions/external-id'
import type { RawTransaction, IngestResult, IngestOptions } from '@/types'
import type { StoredAccount, TransactionsFetchStrategy } from '../types'

/** Ingest function signature: matches lib/transactions/ingest */
export type IngestFn = (
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  raw: RawTransaction[],
  options?: IngestOptions
) => Promise<IngestResult>

export interface SyncOptions {
  /** Skip auto-categorization during ingestion (e.g. SIE overlap) */
  skipAutoCategorization?: boolean
  /** Only INSERT + dedup, no matching/categorization (viewer imports) */
  rawInsertOnly?: boolean
  /**
   * Fetch strategy passed to Enable Banking. 'longest' instructs the upstream
   * to fetch the deepest available history (slower); omit for incremental syncs.
   */
  strategy?: TransactionsFetchStrategy
}

/**
 * How long a stored account balance stays fresh before a sync refreshes it.
 * PSD2 unattended consents allow only 4 balance calls per account per day
 * (observed: 429 "Consent daily limit 4 is exceeded"), while transaction
 * fetches are budgeted separately. 12h keeps at most 2 balance calls per day
 * regardless of how many manual "Synka nu" clicks or cron runs happen.
 */
const BALANCE_MAX_AGE_MS = 12 * 60 * 60 * 1000

export interface SyncResult {
  imported: number
  duplicates: number
  errors: number
  /** Earliest booking date the ASPSP returned. Undefined when no transactions came back. */
  returnedMinBookingDate?: string
  /** Latest booking date the ASPSP returned. Undefined when no transactions came back. */
  returnedMaxBookingDate?: string
  /** The date_from asked of the bank. */
  requestedFromDate: string
  /**
   * The date_from the bank actually answered. Equal to requestedFromDate
   * unless the bank refused the window and a narrower one was used; the sync
   * is then complete only from this date on (#2202). Undefined through the
   * hosted connector, which does not report it.
   */
  effectiveFromDate?: string
  /** True when the bank refused the requested window and the history was cut. */
  historyNarrowed: boolean
}

/**
 * The PSD2 session id rests on the connection row (never on the account
 * payload) and stays on this installation: an adapter that needs it receives
 * it per call and proves ownership on its own side.
 */
async function loadSessionId(supabase: SupabaseClient, connectionId: string): Promise<string> {
  const { data: row, error } = await supabase
    .from('bank_connections')
    .select('session_id')
    .eq('id', connectionId)
    .maybeSingle()
  if (error) throw new Error(`Bank sync could not read the connection: ${error.message}`)
  const sessionId = (row as { session_id: string | null } | null)?.session_id
  if (!sessionId) throw new Error('Bank sync requires a connection with a session id')
  return sessionId
}

/**
 * Sync transactions for a single bank account via Enable Banking PSD2.
 *
 * Fetches transactions from the Enable Banking API, converts to RawTransaction
 * format, and delegates to the shared ingestion pipeline. Raw API responses
 * are archived as räkenskapsinformation per BFL 7 kap.
 *
 * @param ingest - Optional ingest function override (defaults to core ingestTransactions).
 *                 When called from an extension handler with ctx.services.ingestTransactions,
 *                 pass that function to avoid direct @/lib imports.
 */
export async function syncAccountTransactions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  connectionId: string,
  account: StoredAccount,
  fromDate: string,
  toDate: string,
  ingest: IngestFn = defaultIngest,
  syncOptions?: SyncOptions
): Promise<SyncResult> {
  console.log('[enable-banking] syncAccountTransactions starting', {
    connectionId,
    accountUid: account.uid,
    accountIban: account.iban,
    fromDate,
    toDate,
    strategy: syncOptions?.strategy,
  })

  // The bank feed adapter (this installation's own Enable Banking
  // credentials, or Accounted Connect) is chosen by the ledger's registry per
  // company. Everything below the adapter call (external ids, ingest,
  // archive, balance) is provider neutral, so a company moved between
  // adapters produces byte-identical stored keys.
  const adapter = selectBankFeedAdapter(companyId)
  const sessionId = adapter.needsSessionId ? await loadSessionId(supabase, connectionId) : null
  const feed = await adapter.syncBooked({
    companyId,
    connectionId,
    sessionId,
    accountUid: account.uid,
    accountCurrency: account.currency,
    acceptedHistoryDays: account.accepted_history_days,
    fromDate,
    toDate,
    strategy: syncOptions?.strategy,
  })
  const rawPages = feed.rawPages
  const bookedEntries: Array<{ tx: BookedBankTransaction; bookingDate: string }> = feed.transactions.map((tx) => ({
    tx,
    bookingDate: tx.booking_date,
  }))
  const totalFetched = feed.transactions.length + feed.skippedPending
  const effectiveFromDate = feed.effectiveFromDate
  const historyNarrowed = feed.narrowed
  // Remember the widest window this bank has ANSWERED for the account, so a
  // later rejection of a window no wider than it is read as the bank being
  // unavailable rather than as a too-wide window (#2202). Never shrinks:
  // an incremental 7-day sync must not forget that 90 days once worked.
  // Stamped on the account object; the caller's accounts_data write-back
  // persists it, exactly like dedup_scope and the balance fields.
  const acceptedDays = historyWindowDays(effectiveFromDate, toDate)
  if (acceptedDays !== undefined && acceptedDays > (account.accepted_history_days ?? -1)) {
    account.accepted_history_days = acceptedDays
  }
  if (historyNarrowed) {
    console.warn('[enable-banking] Bank refused the requested history window; synced a narrower one', {
      connectionId,
      accountUid: account.uid,
      requestedFromDate: fromDate,
      effectiveFromDate,
      toDate,
    })
  }

  // Log the actual date range returned so we can compare against the requested
  // window. Helps diagnose when an ASPSP truncates history below what we asked for.
  let minBookingDate: string | undefined
  let maxBookingDate: string | undefined
  for (const { bookingDate } of bookedEntries) {
    if (!minBookingDate || bookingDate < minBookingDate) minBookingDate = bookingDate
    if (!maxBookingDate || bookingDate > maxBookingDate) maxBookingDate = bookingDate
  }

  console.log('[enable-banking] Fetched transactions', {
    connectionId,
    accountUid: account.uid,
    via: adapter.provider,
    transactionCount: totalFetched,
    rawPageCount: rawPages.length,
    requestedFromDate: fromDate,
    effectiveFromDate,
    requestedToDate: toDate,
    returnedMinBookingDate: minBookingDate,
    returnedMaxBookingDate: maxBookingDate,
    strategy: syncOptions?.strategy,
  })

  const skippedPending = totalFetched - bookedEntries.length
  if (skippedPending > 0) {
    console.log('[enable-banking] Skipped pending transactions (no booking_date)', {
      connectionId,
      accountUid: account.uid,
      skippedPending,
      total: totalFetched,
    })
  }

  // Derive a stable, content-based external_id per booked transaction. We
  // deliberately do NOT key off the bank's transaction id (entry_reference/
  // transaction_id): many Swedish ASPSPs regenerate those across requests, so a
  // repeat "synka nu" produced a fresh id and re-imported transactions the user
  // had already booked. buildStableExternalIds derives the id from (account,
  // booking_date, amount) plus an occurrence index, so re-syncs collide on
  // (company_id, external_id) and dedupe while genuinely identical transactions
  // are still kept apart. Normalize the IBAN (strip whitespace, uppercase) so
  // formatting variants from the ASPSP ("SE45 5000 …" vs "SE455000…") don't
  // change the scope and orphan every prior external_id. Falls back to the
  // provider account uid.
  //
  // account.dedup_scope, when present, wins outright: it pins the scope the
  // account was FIRST ingested under, so a re-authorization that mints a new
  // uid (common for no-IBAN accounts) keeps producing byte-identical ids
  // instead of re-importing the whole history. The id FORMAT itself is frozen
  // (see lib/transactions/external-id.ts); only the scope input is stabilized.
  // Stamped back onto the account here for legacy rows so the caller's
  // accounts_data write-back persists it.
  const accountScope =
    account.dedup_scope || account.iban?.replace(/\s+/g, '').toUpperCase() || account.uid
  if (!account.dedup_scope) account.dedup_scope = accountScope
  const externalIds = buildStableExternalIds(
    'eb',
    accountScope,
    bookedEntries.map(({ tx, bookingDate }) => ({ date: bookingDate, amount: tx.amount }))
  )

  // Convert Enable Banking format to generic RawTransaction. counterparty
  // identification: prefer IBAN (international, normalized) over BBAN/BG
  // numbers: the own-account detector matches on IBAN first, falling back
  // to counterparty_account for Swedish domestic transfers.
  const rawTransactions: RawTransaction[] = bookedEntries.map(({ tx, bookingDate }, i) => {
    const cpAccount = tx.counterparty_account ?? null
    const looksLikeIban = cpAccount && /^[A-Z]{2}\d/.test(cpAccount.replace(/\s+/g, ''))
    return {
      // The booked date is both the stable dedup anchor (see bookedEntries) and
      // the accounting-correct ledger date; keep it identical to the value the
      // external_id was derived from.
      date: bookingDate,
      // tx.description is already non-empty (the adapter guarantees a
      // label); the trailing fallbacks are defensive. Ingest re-normalizes.
      description: tx.description || tx.counterparty_name || FALLBACK_DESCRIPTION,
      amount: tx.amount,
      currency: tx.currency || account.currency,
      external_id: externalIds[i],
      mcc_code: tx.merchant_category_code ? parseInt(tx.merchant_category_code, 10) : null,
      merchant_name: tx.counterparty_name || null,
      reference: tx.reference || null,
      bank_connection_id: connectionId,
      import_source: 'enable_banking',
      counterparty_iban: looksLikeIban ? cpAccount!.replace(/\s+/g, '') : null,
      counterparty_account: !looksLikeIban ? cpAccount : null,
      // Verbatim transaction-type codes: the ingest boundary classifies them
      // into transaction_method and persists them as evidence columns.
      bank_transaction_code: tx.bank_transaction_code || null,
      proprietary_bank_transaction_code: tx.proprietary_bank_transaction_code || null,
    }
  })

  const ingestOptions: IngestOptions = {}
  if (syncOptions?.skipAutoCategorization) ingestOptions.skipAutoCategorization = true
  if (syncOptions?.rawInsertOnly) ingestOptions.rawInsertOnly = true
  // Per-account ledger routing: the mapping engine consumes settlementAccount
  // for the bank-side leg, falling back to '1930' when unset.
  if (account.ledger_account) ingestOptions.settlementAccount = account.ledger_account
  const ingestResult = await ingest(supabase, companyId, userId, rawTransactions, ingestOptions)

  console.log('[enable-banking] Ingest result', {
    connectionId,
    accountUid: account.uid,
    imported: ingestResult.imported,
    duplicates: ingestResult.duplicates,
    errors: ingestResult.errors,
  })

  // Archive raw PSD2 API responses as räkenskapsinformation (BFL 7 kap)
  for (let i = 0; i < rawPages.length; i++) {
    try {
      const fileName = `psd2-response_${connectionId}_${account.uid}_${new Date().toISOString().replace(/[:.]/g, '-')}_p${i + 1}.json`
      const buffer = new TextEncoder().encode(rawPages[i]).buffer as ArrayBuffer
      await uploadDocument(supabase, userId, companyId,
        { name: fileName, buffer, type: 'application/json' },
        { upload_source: 'api' }
      )
    } catch (archiveError) {
      console.error(`[enable-banking] Failed to archive raw response page ${i + 1}:`, archiveError)
      // Archival failure must not fail the sync
    }
  }

  // Update account balance, but only when the stored one has gone stale:
  // every skipped call preserves the account's scarce daily BALANCES quota
  // (see BALANCE_MAX_AGE_MS). balance_updated_at is written ONLY on a
  // successful refresh below, so a stale/missing/invalid timestamp always
  // falls through to a refresh attempt (NaN and Infinity both fail the
  // freshness comparison). A FUTURE timestamp (clock skew, bad data) yields a
  // negative age; treat it as stale too, or refreshes would be suppressed
  // until the wall clock catches up.
  const balanceAgeMs = account.balance_updated_at
    ? Date.now() - new Date(account.balance_updated_at).getTime()
    : Number.POSITIVE_INFINITY
  const balanceIsFresh = balanceAgeMs >= 0 && balanceAgeMs < BALANCE_MAX_AGE_MS
  if (balanceIsFresh) {
    console.log('[enable-banking] Skipping balance refresh (stored balance is fresh)', {
      connectionId,
      accountUid: account.uid,
      balanceUpdatedAt: account.balance_updated_at,
    })
  } else {
    try {
      const balance = await getAccountBalance(account.uid)
      // null = the ASPSP returned no balances at all. Keep the previous
      // stored value and timestamp; writing a fabricated 0 with a fresh
      // timestamp would pin "the bank reports 0 kr" for the next 12h on
      // every balance surface.
      if (balance) {
        account.balance = balance.amount
        // Overwrite (not keep) on null: a stale available figure next to a
        // fresh booked figure would misstate what can be spent.
        account.available_balance = balance.available ?? undefined
        account.balance_updated_at = new Date().toISOString()
      }
    } catch {
      // Keep previous balance, don't update timestamp
    }
  }

  return {
    imported: ingestResult.imported,
    duplicates: ingestResult.duplicates,
    errors: ingestResult.errors,
    returnedMinBookingDate: minBookingDate,
    returnedMaxBookingDate: maxBookingDate,
    requestedFromDate: fromDate,
    effectiveFromDate,
    historyNarrowed,
  }
}
