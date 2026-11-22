/**
 * One Open Payments account's booked transactions into the ledger, through
 * the same guarded path as Enable Banking:
 *
 *   route    the caller resolved resolve_bank_ingest_route (the account must
 *            be bound to its cash account) before the bank is asked;
 *   fetch    Connect's syncTransactions: the service pages through the bank's
 *            history and answers in the bank sync shape;
 *   map      'eb' external ids with the same scope rule as Enable Banking
 *            (dedup_scope, else the normalised IBAN, else the account uid),
 *            import_source 'open_payments', value date, end-to-end id, the
 *            bank's own id, the counterparty IBAN, and what the bank's daily
 *            enrichment adds (organisationsnummer, the instructed amount of
 *            a foreign purchase, the balance after, the enriched flag);
 *   archive  every raw page as räkenskapsinformation (BFL 7 kap), each row
 *            linked to the page it arrived in, each page recorded as a
 *            bank_feed arrival (./page-arrival.ts);
 *   ingest   lib/transactions/ingest.ts with the route, so every row goes
 *            through insert_bank_transaction and its dedupe layers, and a
 *            re-read row that arrives richer updates its stored row;
 *   enrich   the sync response's enrichment (the account's last enrichment
 *            time and whether the window carries it) is handed back for the
 *            connection row and the sync log;
 *   balance  refreshed when the stored one is older than BALANCE_MAX_AGE_MS.
 *
 * The Enable Banking sync (extensions/general/enable-banking/lib/sync.ts)
 * delegates here when the route names the Open Payments aggregator; the
 * Open Payments runner (./feed.ts) calls it directly. Failures are the
 * adapter's typed errors (./connect.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AisParty, BankSyncEnrichment, NormalizedBankTransaction } from '@accounted/connect-contract'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { ingestTransactions as defaultIngest } from '@/lib/transactions/ingest'
import { buildStableExternalIds, dropRepeatedBankRows, FALLBACK_DESCRIPTION } from '@/lib/transactions/external-id'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { isNordeaCardHold } from '@/lib/bank-sync/card-hold'
import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'
import type { BankIngestRoute, IngestOptions, IngestResult, RawTransaction } from '@/types'
import { ConsentOverError, getBankFeedConnect, type BankFeedConnect } from './connect'
import { recordBankFeedPageArrival } from './page-arrival'
import { accountDedupScope } from './account-scope'
import { createLogger } from '@/lib/logger'

const archiveLog = createLogger('bank-feed/sync')

/** Two balance reads a day at most: the consent's unattended budget is small. */
export const BALANCE_MAX_AGE_MS = 12 * 60 * 60 * 1000

export type BankFeedIngestFn = (
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  raw: RawTransaction[],
  options?: IngestOptions,
) => Promise<IngestResult>

/** The accounts_data entry of an Open Payments account: the StoredAccount shape plus what only this feed reports. */
export interface BankFeedAccount {
  uid: string
  currency: string
  iban?: string | null
  bban?: string | null
  name?: string | null
  enabled?: boolean
  ledger_account?: string | null
  dedup_scope?: string | null
  balance?: number | null
  available_balance?: number | null
  balance_updated_at?: string | null
  /** ORGA (the company's) or PRIV (the signer's own), as the bank reports it. */
  usage?: string | null
}

export interface BankFeedAccountSyncInput {
  companyId: string
  userId: string
  connectionId: string
  /** The account, mutated like Enable Banking's: dedup_scope and the balance fields are stamped for the write-back. */
  account: BankFeedAccount
  fromDate: string
  toDate: string
  /** The verified route of this account (resolveBankIngestRoute), naming the consent as sessionId. */
  bankRoute: BankIngestRoute
  party: AisParty
  ingest?: BankFeedIngestFn
  /**
   * The connection's bank (bank_connections.bank_name): a Nordea card hold is
   * not booked, in the read or stored before (isNordeaCardHold).
   */
  bankName?: string | null
  options?: Pick<IngestOptions, 'skipAutoCategorization' | 'rawInsertOnly'>
  /**
   * Ask the service for the account's enrichment facts (one extra details
   * read at the bank). The runner sets it on an unattended sync whose stored
   * last_enriched_at is missing or older than today; a sync a person
   * triggered never asks.
   */
  includeEnrichment?: boolean
  connect?: BankFeedConnect
  now?: number
  /**
   * Told the ids of the rows ingest stored, as soon as it has stored them and
   * before the checks that can still fail this account (rows ingest rejected,
   * a consent that ended on the balance read). The rows are in the inbox
   * either way, and a caller that announces stored rows needs them on the
   * failure path too: the next read finds them as duplicates and never
   * announces them.
   */
  onStored?: (transactionIds: readonly string[]) => void
}

export interface BankFeedAccountSyncResult {
  imported: number
  duplicates: number
  errors: number
  transactionIds: string[]
  returnedMinBookingDate?: string
  returnedMaxBookingDate?: string
  requestedFromDate: string
  effectiveFromDate?: string
  historyNarrowed: boolean
  /** The service hit its page cap before the bank ran out of pages: the window is incomplete. */
  truncated: boolean
  /** What the account details said about the bank's enrichment; null when the bank or an older service reports nothing. */
  enrichment: { lastEnrichedAt: string | null; windowEnriched: boolean } | null
  /** Stored rows the re-read updated with richer data (IngestResult.enriched_updated). */
  enrichedUpdated: number
  /** Rows in another currency than the account's, set aside by ingest (IngestResult.other_currency); omitted when none. */
  otherCurrency?: number
}

function looksLikeIban(value: string | null | undefined): boolean {
  return Boolean(value && /^[A-Z]{2}\d/.test(value.replace(/\s+/g, '').toUpperCase()))
}

export { accountDedupScope }

/**
 * The service's rows as ingest rows. External ids come from the same function
 * and the same 'eb' prefix as Enable Banking's, so an account that moves
 * between the two aggregators keeps its stored keys and nothing is imported
 * twice. `rowsWithoutPage` counts the rows whose raw_page_index names no
 * page of the response (missing, or past the last page): those rows can
 * never be linked to the bank's answer, whatever the archive did.
 */
export function mapBankFeedRows(input: {
  rows: readonly NormalizedBankTransaction[]
  account: Pick<BankFeedAccount, 'uid' | 'iban' | 'currency' | 'dedup_scope'>
  connectionId: string
  archivedPageIds: ReadonlyArray<string | null>
}): { rows: RawTransaction[]; scope: string; minBookingDate?: string; maxBookingDate?: string; repeatsDropped: number; rowsWithoutPage: number } {
  const scope = accountDedupScope(input.account)
  // A bank entry the response served more than once is one transaction
  // (crm#1295): dropped before the ids are built, exactly as Enable Banking does.
  const unique = dropRepeatedBankRows(input.rows, (tx) => ({
    providerTransactionId: tx.provider_transaction_id,
    date: tx.booking_date,
    amount: tx.amount,
    description: tx.description,
  }))
  const ids = buildStableExternalIds('eb', scope, unique.map((tx) => ({ date: tx.booking_date, amount: tx.amount })))
  let minBookingDate: string | undefined
  let maxBookingDate: string | undefined
  let rowsWithoutPage = 0
  const accountCurrency = input.account.currency.toUpperCase()
  const rows = unique.map((tx, i): RawTransaction => {
    if (!minBookingDate || tx.booking_date < minBookingDate) minBookingDate = tx.booking_date
    if (!maxBookingDate || tx.booking_date > maxBookingDate) maxBookingDate = tx.booking_date
    const cpAccount = tx.counterparty_account ?? null
    const cpIban = normalizeIban(tx.counterparty_iban) ?? (looksLikeIban(cpAccount) ? normalizeIban(cpAccount) : null)
    // The archived page's document: undefined when the row names no page of
    // the response, null when that page failed to archive (the sync logs that).
    const archivedPage: string | null | undefined = tx.raw_page_index == null ? undefined : input.archivedPageIds[tx.raw_page_index]
    if (archivedPage === undefined) rowsWithoutPage++
    const rowCurrency = (tx.currency || accountCurrency).toUpperCase()
    const instructedCurrency = tx.instructed_currency?.toUpperCase() || null
    const foreignPurchase = tx.instructed_amount != null && instructedCurrency !== null && instructedCurrency !== rowCurrency
    // The Bankgirot split, when the bank sent one: ingest stores it beside
    // the row (bank_transaction_parts) and suggests the invoice behind each
    // part. An empty array is never sent (the contract says null), but map
    // it to null all the same so a row without a split carries none.
    const parts = tx.parts && tx.parts.length > 0 ? tx.parts : null
    return {
      date: tx.booking_date,
      description: tx.description || tx.counterparty_name || FALLBACK_DESCRIPTION,
      amount: tx.amount,
      currency: (tx.currency || input.account.currency).toUpperCase(),
      external_id: ids[i]!,
      mcc_code: tx.merchant_category_code ? parseInt(tx.merchant_category_code, 10) : null,
      merchant_name: tx.counterparty_name || null,
      reference: tx.reference || null,
      value_date: tx.value_date || null,
      end_to_end_id: tx.end_to_end_id || null,
      provider_transaction_id: tx.provider_transaction_id || null,
      raw_document_id: archivedPage ?? null,
      bank_connection_id: input.connectionId,
      import_source: OPEN_PAYMENTS_AGGREGATOR,
      counterparty_iban: cpIban,
      counterparty_account: cpAccount && !looksLikeIban(cpAccount) ? cpAccount : null,
      bank_transaction_code: tx.bank_transaction_code || null,
      proprietary_bank_transaction_code: tx.proprietary_bank_transaction_code || null,
      counterparty_org_number: tx.counterparty_org_number || null,
      instructed_amount: foreignPurchase ? tx.instructed_amount : null,
      instructed_currency: foreignPurchase ? instructedCurrency : null,
      // The bank's rate only where the row's own amount is already SEK: on a
      // foreign-currency account exchange_rate is the Riksbanken SEK rate
      // ingest fetches, and the bank's rate into that currency must not
      // take its place.
      exchange_rate: foreignPurchase && rowCurrency === 'SEK' ? tx.exchange_rate ?? null : null,
      balance_after: tx.balance_after ?? null,
      is_enriched: tx.is_enriched ?? null,
      parts,
    }
  })
  return { rows, scope, minBookingDate, maxBookingDate, repeatsDropped: input.rows.length - unique.length, rowsWithoutPage }
}

/** The sync response's enrichment in the result's shape; null when the service reported nothing. */
export function enrichmentOf(enrichment: BankSyncEnrichment | null | undefined): BankFeedAccountSyncResult['enrichment'] {
  if (!enrichment) return null
  return { lastEnrichedAt: enrichment.last_enriched_at ?? null, windowEnriched: enrichment.window_enriched === true }
}

export async function syncOpenPaymentsAccount(supabase: SupabaseClient, input: BankFeedAccountSyncInput): Promise<BankFeedAccountSyncResult> {
  const connect = input.connect ?? getBankFeedConnect()
  if (!connect) throw new Error('Open Payments is not configured on this installation')
  const { companyId, userId, connectionId, account, fromDate, toDate, bankRoute } = input
  const ingest = input.ingest ?? defaultIngest
  const now = input.now ?? Date.now()

  const remote = await connect.syncTransactions(companyId, {
    party: input.party,
    consentId: bankRoute.sessionId,
    accountUid: account.uid,
    accountCurrency: account.currency.toUpperCase(),
    ...(account.usage ? { accountUsage: account.usage } : {}),
    dateFrom: fromDate,
    dateTo: toDate,
    ...(input.includeEnrichment ? { include_enrichment: true } : {}),
  })

  // The bank's answer is räkenskapsinformation (BFL 7 kap): archived before
  // anything is booked from it. An archive failure never fails the sync.
  const archivedPageIds: Array<string | null> = []
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  for (let i = 0; i < remote.raw_pages.length; i++) {
    archivedPageIds.push(null)
    try {
      const buffer = new TextEncoder().encode(remote.raw_pages[i]).buffer as ArrayBuffer
      const archived = await uploadDocument(supabase, userId, companyId,
        { name: `psd2-response_${connectionId}_${account.uid}_${stamp}_p${i + 1}.json`, buffer, type: 'application/json' },
        { upload_source: 'api' })
      archivedPageIds[i] = archived.id
    } catch (archiveError) {
      // The page's rows land without their BFL 7 kap evidence for good (a re-sync
      // deduplicates them): an error, though it never fails the sync.
      archiveLog.error('raw bank response page not archived', archiveError as Error, { connectionId, companyId, accountUid: account.uid, page: i + 1 })
    }
    // How the page came in (best effort, never fails the sync).
    const pageId = archivedPageIds[i]
    if (pageId) {
      await recordBankFeedPageArrival(supabase, {
        companyId, userId, documentId: pageId, connectionId, accountUid: account.uid, page: i + 1, aggregator: 'open_payments',
      })
    }
  }

  // Connect leaves Nordea's card holds out of the read. One that still comes
  // through is not booked either, so it is left out here too, before the ids
  // are built, as the Enable Banking sync does (isNordeaCardHold, crm#2076).
  const bankName = input.bankName
  const booked = bankName ? remote.transactions.filter((tx) => !isNordeaCardHold(bankName, tx.description)) : remote.transactions
  if (booked.length < remote.transactions.length) {
    archiveLog.info('card holds left out of the read', { connectionId, accountUid: account.uid, cardHolds: remote.transactions.length - booked.length })
  }
  const mapped = mapBankFeedRows({ rows: booked, account, connectionId, archivedPageIds })
  if (!account.dedup_scope) account.dedup_scope = mapped.scope
  if (mapped.rowsWithoutPage > 0) {
    // The contract keeps raw_page_index optional so an older service still
    // parses, so a service that leaves it out passes every check and its rows
    // are stored with no link to the bank's answer (BFL 7 kap, #87). Said
    // once per sync so it reaches error tracking the same day.
    archiveLog.error('bank rows name no page of the response: stored without a link to the raw bank page', {
      connectionId,
      companyId,
      accountUid: account.uid,
      rowsWithoutPage: mapped.rowsWithoutPage,
      rows: mapped.rows.length,
      pages: remote.raw_pages.length,
    })
  }
  if (mapped.repeatsDropped > 0) {
    console.warn('[bank-feed] Dropped bank rows the response repeated', {
      connectionId,
      accountUid: account.uid,
      repeated: mapped.repeatsDropped,
      total: remote.transactions.length,
    })
  }

  const ingestOptions: IngestOptions = { bankRoute, settlementAccount: bankRoute.ledgerAccount }
  if (input.options?.skipAutoCategorization) ingestOptions.skipAutoCategorization = true
  if (input.options?.rawInsertOnly) ingestOptions.rawInsertOnly = true
  // A hold stored before the holds were left out (by either feed) still
  // holds its index: ingest must not hand it the purchase booked on its day
  // for its amount (crm#2076).
  if (bankName) ingestOptions.isNotBooked = (text) => isNordeaCardHold(bankName, text)
  const result = await ingest(supabase, companyId, userId, mapped.rows, ingestOptions)
  input.onStored?.(result.transaction_ids ?? [])
  // Rows in another currency than the account's are set aside by ingest, not
  // a failed batch (crm#1767); the count travels with the result.
  const otherCurrency = Object.values(result.other_currency ?? {}).reduce((sum, rows) => sum + rows, 0)
  if (result.errors > 0) {
    // Keep the previous cursor so a retry fetches the incomplete batch again;
    // the rows already inserted keep their external ids and dedupe.
    throw Object.assign(new Error(`Bank transaction persistence failed: ${result.first_error?.message ?? `${result.errors} rows rejected`}`), {
      code: result.first_error?.code,
    })
  }

  // The balance only when the stored one has gone stale: every skipped call
  // preserves the consent's scarce unattended budget. A consent that is over
  // fails the sync; any other balance failure keeps the previous figure.
  const balanceAgeMs = account.balance_updated_at ? now - new Date(account.balance_updated_at).getTime() : Number.POSITIVE_INFINITY
  if (!(balanceAgeMs >= 0 && balanceAgeMs < BALANCE_MAX_AGE_MS)) {
    try {
      const balances = await connect.balances(companyId, { party: input.party, consentId: bankRoute.sessionId, accountUid: account.uid })
      if (balances.booked !== null) {
        account.balance = balances.booked
        account.available_balance = balances.available ?? undefined
        account.balance_updated_at = new Date(now).toISOString()
      }
    } catch (balanceError) {
      if (balanceError instanceof ConsentOverError) throw balanceError
    }
  }

  return {
    imported: result.imported,
    duplicates: result.duplicates,
    errors: result.errors,
    transactionIds: result.transaction_ids ?? [],
    returnedMinBookingDate: mapped.minBookingDate,
    returnedMaxBookingDate: mapped.maxBookingDate,
    requestedFromDate: fromDate,
    effectiveFromDate: remote.effective_date_from ?? undefined,
    historyNarrowed: Boolean(remote.effective_date_from && remote.effective_date_from > fromDate),
    truncated: remote.truncated === true,
    enrichment: enrichmentOf(remote.enrichment),
    enrichedUpdated: result.enriched_updated ?? 0,
    ...(otherCurrency > 0 ? { otherCurrency } : {}),
  }
}
