import type { SupabaseClient } from '@supabase/supabase-js'
import { getAllTransactionsWithRaw, convertTransaction, getAccountBalance } from './api-client'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { ingestTransactions as defaultIngest } from '@/lib/transactions/ingest'
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

  // Convert Enable Banking format to generic RawTransaction. counterparty
  // identification: prefer IBAN (international, normalized) over BBAN/BG
  // numbers — the own-account detector matches on IBAN first, falling back
  // to counterparty_account for Swedish domestic transfers.
  const rawTransactions: RawTransaction[] = bankTransactions.map((tx) => {
    const cpAccount = tx.counterparty_account ?? null
    const looksLikeIban = cpAccount && /^[A-Z]{2}\d/.test(cpAccount.replace(/\s+/g, ''))
    return {
      date: tx.booking_date || tx.date,
      description: tx.description || tx.counterparty_name || 'Unknown',
      amount: tx.amount,
      currency: tx.currency || account.currency,
      external_id: `eb_${account.iban || account.uid}_${tx.id}`,
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
