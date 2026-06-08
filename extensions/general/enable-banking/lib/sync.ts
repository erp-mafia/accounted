import type { SupabaseClient } from '@supabase/supabase-js'
import { getAllTransactionsWithRaw, convertTransaction, getAccountBalance } from './api-client'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { ingestTransactions as defaultIngest } from '@/lib/transactions/ingest'
import { buildStableExternalIds, FALLBACK_DESCRIPTION } from '@/lib/transactions/external-id'
import type { RawTransaction, IngestResult, IngestOptions } from '@/types'
import type { StoredAccount, TransactionsFetchStrategy } from '../types'

/** Ingest function signature — matches lib/transactions/ingest */
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

export interface SyncResult {
  imported: number
  duplicates: number
  errors: number
  /** Earliest booking date the ASPSP returned. Undefined when no transactions came back. */
  returnedMinBookingDate?: string
  /** Latest booking date the ASPSP returned. Undefined when no transactions came back. */
  returnedMaxBookingDate?: string
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

  const { transactions, rawPages } = await getAllTransactionsWithRaw(
    account.uid,
    fromDate,
    toDate,
    syncOptions?.strategy,
  )

  // Log the actual date range returned so we can compare against the requested
  // window. Helps diagnose when an ASPSP truncates history below what we asked for.
  let minBookingDate: string | undefined
  let maxBookingDate: string | undefined
  for (const tx of transactions) {
    const d = tx.booking_date || tx.value_date
    if (!d) continue
    if (!minBookingDate || d < minBookingDate) minBookingDate = d
    if (!maxBookingDate || d > maxBookingDate) maxBookingDate = d
  }

  console.log('[enable-banking] Fetched transactions from API', {
    connectionId,
    accountUid: account.uid,
    transactionCount: transactions.length,
    rawPageCount: rawPages.length,
    requestedFromDate: fromDate,
    requestedToDate: toDate,
    returnedMinBookingDate: minBookingDate,
    returnedMaxBookingDate: maxBookingDate,
    strategy: syncOptions?.strategy,
  })

  const bankTransactions = transactions.map(tx => convertTransaction(tx, account.currency))

  // Only ingest BOOKED transactions — those the ASPSP returned with a real
  // booking_date. Pending entries are intentionally skipped: a pending row is
  // unstable across syncs (a later "synka nu" returns the same transaction
  // either still pending or finally booked, often with a *different* effective
  // date). Because BOTH the dedup external_id and the content-dedup key are
  // date-derived, that drift mints a brand-new id and re-imports a transaction
  // that already exists. Observed in production as the same amount+description
  // landing twice with different dates — the bank's value_date in one sync, its
  // booking_date in another. Gating the import set on a stable booking_date
  // removes the drift at the source, and leaves booked rows' ids byte-identical
  // (so the existing rows are NOT re-orphaned).
  //
  // booking_date is read from the RAW transaction (transactions[i]), index-
  // aligned with bankTransactions: convertTransaction's booking_date already
  // falls back to value_date/today, so it cannot tell booked from pending.
  const bookedEntries = bankTransactions.flatMap((tx, i) => {
    const bookingDate = transactions[i]?.booking_date
    return typeof bookingDate === 'string' && bookingDate.trim() !== ''
      ? [{ tx, bookingDate: bookingDate.trim() }]
      : []
  })

  const skippedPending = bankTransactions.length - bookedEntries.length
  if (skippedPending > 0) {
    console.log('[enable-banking] Skipped pending transactions (no booking_date)', {
      connectionId,
      accountUid: account.uid,
      skippedPending,
      total: bankTransactions.length,
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
  const accountScope = account.iban?.replace(/\s+/g, '').toUpperCase() || account.uid
  const externalIds = buildStableExternalIds(
    'eb',
    accountScope,
    bookedEntries.map(({ tx, bookingDate }) => ({ date: bookingDate, amount: tx.amount }))
  )

  // Convert Enable Banking format to generic RawTransaction. counterparty
  // identification: prefer IBAN (international, normalized) over BBAN/BG
  // numbers — the own-account detector matches on IBAN first, falling back
  // to counterparty_account for Swedish domestic transfers.
  const rawTransactions: RawTransaction[] = bookedEntries.map(({ tx, bookingDate }, i) => {
    const cpAccount = tx.counterparty_account ?? null
    const looksLikeIban = cpAccount && /^[A-Z]{2}\d/.test(cpAccount.replace(/\s+/g, ''))
    return {
      // The booked date is both the stable dedup anchor (see bookedEntries) and
      // the accounting-correct ledger date; keep it identical to the value the
      // external_id was derived from.
      date: bookingDate,
      // tx.description is already non-empty (convertTransaction guarantees a
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
    }
  })

  const ingestOptions: IngestOptions = {}
  if (syncOptions?.skipAutoCategorization) ingestOptions.skipAutoCategorization = true
  if (syncOptions?.rawInsertOnly) ingestOptions.rawInsertOnly = true
  // Per-account ledger routing — the mapping engine consumes settlementAccount
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

  // Update account balance
  try {
    const balance = await getAccountBalance(account.uid)
    account.balance = balance.amount
    account.balance_updated_at = new Date().toISOString()
  } catch {
    // Keep previous balance, don't update timestamp
  }

  return {
    imported: ingestResult.imported,
    duplicates: ingestResult.duplicates,
    errors: ingestResult.errors,
    returnedMinBookingDate: minBookingDate,
    returnedMaxBookingDate: maxBookingDate,
  }
}
