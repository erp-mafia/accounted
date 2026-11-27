import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { chartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import type { InvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { chunk } from '@/lib/utils'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { amountToOre, BANK_REDATE_MAX_DAYS, contentBucketKey, descriptionsBridge, normalizeImportedDescription, reconcileStableExternalIds } from '@/lib/transactions/external-id'
import { addDaysIso } from '@/lib/dates/iso'
import { classifyTransactionMethod } from '@/lib/transactions/transaction-method'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { applyTransactionSplit } from '@/lib/transactions/parts-apply'
import { createLogger } from '@/lib/logger'
import { INGEST_MATCHERS } from '@/lib/composition/ingest-matchers'
import { OPEN_INVOICES } from '@/lib/composition/open-invoices'
import { DEPOSIT_SPLIT_BOOKING } from '@/lib/composition/deposit-split-booking'
import { INGEST_FEEDS } from '@/lib/composition/ingest-feeds'
import { feedCarriesSplits, feedRereadsStoredRows } from '@/lib/transactions/ingest-feed'
import { createIngestClaims, INGEST_POOL_OWNERS, startIngestMatchers, type IngestBatch } from '@/lib/transactions/ingest-matcher'
import {
  gateIngestMatchers,
  ingestPackageGatingEnabled,
  readIngestPackageGate,
  RUN_EVERY_MATCHER,
} from '@/lib/transactions/ingest-package-gate'
import { physicalAccountKey, reenableIfUnused, resolveDefaultCashAccount, sameCashAccount } from '@/lib/cash-accounts/service'
import type { Transaction, RawTransaction, IngestResult, IngestOptions, IngestSkipReason, IngestSkippedRow, SupplierInvoice, Currency, ExchangeRate } from '@/types'
import { MATCHABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { linkBasisColumns } from '@/lib/links/stamp'

/**
 * Sentinel for a (date, öre) bucket whose incoming rows carry more than one
 * currency: the booked-hand-entered mirror's per-bucket currency gate cannot be
 * evaluated there, so the mirror is disabled for that bucket.
 */
const MIXED_CURRENCIES = Symbol('mixed-currencies')

/**
 * One existing row in a content-dedup bucket: its normalized/lowercased
 * description, the cash account it settled on (null for legacy rows that
 * predate the cash_account_id backfill), the import channel it came from, and
 * whether that channel is an external feed (vs a hand-entered row). `source` +
 * `isImportFeed` drive the cross-channel mirror bridge (see
 * `consumeBridgingTwin`); `cashAccountId` is the cross-account guard.
 */
export type BucketEntry = {
  /** Row id of the stored transaction; used to persist hand-mirror adoption. */
  id: string | null
  desc: string
  cashAccountId: string | null
  source: string | null
  isImportFeed: boolean
  /**
   * ISO currency of the stored row ('SEK', 'USD', ...), null for rows without
   * one. Guards EVERY content-dedup match path (text bridge, cross-channel
   * mirror, booked-hand-entered mirror): the content bucket keys on (date, öre)
   * only, so without this a stored 250,00 SEK row and an incoming 250,00 EUR
   * row on the same date share a bucket and either could consume the other.
   * See the currency guard in `consumeBridgingTwin`.
   */
  currency: string | null
  /**
   * The stored row's `external_id`: names the matched row in the skip report
   * and lets isOtherBookingOfSameFeed tell another booking of the same feed
   * from a copy. Null for rows predating the column.
   */
  externalId: string | null
  /**
   * The bank connection the stored row belongs to (null for file imports, API
   * feeds, hand-entered rows, and rows whose connection was deleted). Part of
   * "the same feed" in isOtherBookingOfSameFeed.
   */
  bankConnectionId: string | null
  /**
   * The bank's own id for the stored row (provider_transaction_id): pairs a
   * re-read of the same bank entry with it, also when the bank re-dated the
   * entry (reconcileStableExternalIds).
   */
  providerTransactionId: string | null
  /**
   * The batch's feed reads the stored row as not booked (IngestOptions.isNotBooked):
   * id re-keying never gives it an incoming row (reconcileStableExternalIds),
   * and it is no cross-channel mirror twin (decideIngestRow). Absent for every
   * other row.
   */
  notBooked?: true
}

/**
 * Content-dedup bucket: a `{date}|{öre}` key mapped to the multiset of existing
 * rows in that bucket. Matching is by `descriptionsBridge` (prefix-containment)
 * gated by the account guard, consumed with COUNTING semantics (one entry is
 * spliced out per deduped incoming row), so two genuinely-distinct
 * same-(date,amount) transactions are never collapsed.
 */
export type DescBucket = Map<string, BucketEntry[]>

export interface ExistingTransactionMaps {
  /**
   * Booked transactions (any source): consumed by any incoming raw transaction.
   * Hand-entered rows (import_source manual/mcp/null, no bank connection) in
   * THIS map are also cross-channel-mirror candidates: a booked hand-entered
   * row is the ledger asserting the movement already exists, so an incoming
   * feed row for the same (date, öre, currency, account) in a count-symmetric
   * bucket is the bank's copy of it, not new money (the MCP-then-bank-sync
   * case: user bookkeeps by chat first, connects the bank later).
   */
  booked: DescBucket
  /**
   * Unbooked rows from ANY external import feed (Enable Banking PSD2 sync,
   * bank-file CSV/CAMT import): consumed by any incoming raw transaction
   * regardless of source. Catches the cross-channel re-import: the same bank
   * account pulled once via PSD2 and once via a CSV/CAMT file upload (in either
   * order), plus PSD2 reconnect duplicates whose external_id regenerated.
   * Hand-entered rows (import_source manual/mcp/null) are deliberately
   * excluded HERE: an UNBOOKED hand-entered row is just a staged intent (e.g.
   * an MCP draft awaiting approval), not ledger evidence, so it must never
   * consume an incoming import.
   */
  unbookedImported: DescBucket
  /**
   * The content bucket each stored `external_id` sits in, so a Layer-1 id match
   * consumes its stored row even when the incoming row's date or amount drifted
   * into a different bucket (see consumeByExternalId).
   */
  bucketKeyByExternalId: Map<string, string>
}

/** Push a row into its (date, öre) bucket, normalizing the description. */
function addToBucket(
  bucket: DescBucket,
  id: string | null,
  date: string,
  amount: number | string,
  description: string,
  cashAccountId: string | null,
  source: string | null,
  isImportFeed: boolean,
  currency: string | null,
  externalId: string | null,
  bankConnectionId: string | null,
  providerTransactionId: string | null,
  notBooked: boolean,
): string {
  const key = contentBucketKey(date, amount)
  const entry: BucketEntry = {
    id,
    desc: description.toLowerCase().trim(),
    cashAccountId,
    source,
    isImportFeed,
    currency,
    externalId,
    bankConnectionId,
    providerTransactionId,
    ...(notBooked ? { notBooked: true as const } : {}),
  }
  const entries = bucket.get(key)
  if (entries) entries.push(entry)
  else bucket.set(key, [entry])
  return key
}

/**
 * Remove the stored entry carrying `externalId` from its content bucket once a
 * Layer-1 id match has claimed it. Exported so the dedup preview applies the
 * same rule.
 */
export function consumeByExternalId(maps: ExistingTransactionMaps, externalId: string): void {
  const bucketKey = maps.bucketKeyByExternalId.get(externalId)
  if (bucketKey === undefined) return
  for (const bucket of [maps.booked, maps.unbookedImported]) {
    const entries = bucket.get(bucketKey)
    const idx = entries?.findIndex((entry) => entry.externalId === externalId) ?? -1
    if (idx !== -1) {
      entries!.splice(idx, 1)
      return
    }
  }
}

/**
 * Row shape returned by the two map queries below. `amount` may arrive as a
 * PostgREST numeric string; `contentBucketKey` normalizes it to öre.
 */
type StoredDedupRow = {
  id: string | null
  date: string
  amount: number | string
  original_description: string | null
  description: string | null
  cash_account_id: string | null
  import_source: string | null
  bank_connection_id: string | null
  currency: string | null
  external_id: string | null
  provider_transaction_id?: string | null
}

/**
 * Build the (date, öre)-bucketed maps of already-stored transactions in the
 * batch's date range: the stored-row universe every content-dedup layer works
 * against. The range reaches BANK_REDATE_MAX_DAYS beyond the batch on both
 * sides, so the stored row of an entry the bank has since re-dated is there
 * for the bank-id pairing (reconcileStableExternalIds). Rows on those extra
 * days sit in buckets and id families no incoming row shares, which no other
 * layer reads.
 *
 * Exported for the read-only duplicate PREVIEW
 * (`lib/transactions/dedup-preview.ts`): the preview must see exactly the
 * stored rows execute-side ingest will dedup against, so it reuses this
 * function instead of a lookalike query.
 *
 * Both queries paginate via `fetchAllRows`: PostgREST silently caps a plain
 * select at 1000 rows, so a re-import over a wide date range in an active
 * company used to dedup against a TRUNCATED map and insert the remainder as
 * duplicates. `.order('id')` supplies the stable total order `.range()`
 * paging requires (see fetch-all.ts).
 *
 * @param isNotBooked IngestOptions.isNotBooked: marks the stored rows the
 *   batch's feed reads as not booked (BucketEntry.notBooked), by their bank text.
 */
export async function buildExistingTransactionMaps(
  supabase: SupabaseClient,
  companyId: string,
  rawTransactions: Array<{ date: string }>,
  isNotBooked?: IngestOptions['isNotBooked'],
): Promise<ExistingTransactionMaps> {
  const booked: DescBucket = new Map()
  const unbookedImported: DescBucket = new Map()
  const bucketKeyByExternalId = new Map<string, string>()
  if (rawTransactions.length === 0) return { booked, unbookedImported, bucketKeyByExternalId }

  const dates = rawTransactions.map((t) => t.date).sort()
  const widen = (date: string, days: number) => {
    try {
      return addDaysIso(date, days)
    } catch {
      // Safe to ignore: a date that is no real date stays as sent, so the
      // read filters on it exactly as before this window was widened.
      return date
    }
  }
  const dateFrom = widen(dates[0], -BANK_REDATE_MAX_DAYS)
  const dateTo = widen(dates[dates.length - 1], BANK_REDATE_MAX_DAYS)

  try {
    const bookedRows = await fetchAllRows<StoredDedupRow>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id, date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, currency, external_id, provider_transaction_id')
        .eq('company_id', companyId)
        .not('journal_entry_id', 'is', null)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('id')
        .range(from, to)
    )

    for (const tx of bookedRows) {
      // Key off the immutable bank original, not the user-editable
      // description: a title edit must never make the dedup bridge miss a
      // genuine re-import. Falls back to description for rows predating the
      // original_description column.
      const text = normalizeImportedDescription(tx.original_description ?? tx.description)
      const key = addToBucket(
        booked,
        tx.id ?? null,
        tx.date,
        tx.amount,
        text,
        tx.cash_account_id ?? null,
        tx.import_source ?? null,
        isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
        tx.currency ?? null,
        tx.external_id ?? null,
        tx.bank_connection_id ?? null,
        tx.provider_transaction_id?.trim() || null,
        isNotBooked?.(text) === true,
      )
      if (tx.external_id) bucketKeyByExternalId.set(tx.external_id, key)
    }
  } catch {
    // Non-critical: content-based dedup will be skipped
  }

  try {
    // ALL unbooked import-feed rows, not just enable_banking. An unbooked CSV
    // row must dedup an incoming PSD2 sync of the same account, and an unbooked
    // PSD2 row must dedup an incoming CSV import. Feeds always set a non-null
    // import_source outside the user-created allowlist (manual/mcp); null /
    // manual / mcp are hand-entered and intentionally excluded.
    const unbookedRows = await fetchAllRows<StoredDedupRow>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id, date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, currency, external_id, provider_transaction_id')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .not('import_source', 'is', null)
        .neq('import_source', 'manual')
        .neq('import_source', 'mcp')
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('id')
        .range(from, to)
    )

    for (const tx of unbookedRows) {
      // See booked-map note: dedup on the immutable bank original so a
      // user title edit cannot reopen the duplicate-import window.
      const text = normalizeImportedDescription(tx.original_description ?? tx.description)
      const key = addToBucket(
        unbookedImported,
        tx.id ?? null,
        tx.date,
        tx.amount,
        text,
        tx.cash_account_id ?? null,
        tx.import_source ?? null,
        isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
        tx.currency ?? null,
        tx.external_id ?? null,
        tx.bank_connection_id ?? null,
        tx.provider_transaction_id?.trim() || null,
        isNotBooked?.(text) === true,
      )
      if (tx.external_id) bucketKeyByExternalId.set(tx.external_id, key)
    }
  } catch {
    // Non-critical: reconnect dedup will be skipped
  }

  return { booked, unbookedImported, bucketKeyByExternalId }
}

// ---------------------------------------------------------------------------
// The dedup decision
//
// ONE definition of "is this incoming row already stored?", used by the commit
// loop in ingestTransactions AND by the read-only previews
// (lib/transactions/dedup-preview.ts: the v1 dry-run and the bank-file
// wizard). They used to be separate implementations and drifted: the v1
// dry-run knew only booked rows and had no account guard, currency guard,
// mirrors or id re-keying, so it could promise an import the commit skipped.
//
// Preparation is three reads (the stored content maps, the stored ids, the
// batch's cash account) around two pure steps (rekeyIncomingExternalIds,
// buildIngestDedupState). The per-row decision (decideIngestRow) is pure and
// consumes stored twins as it goes, so walking the same rows in the same order
// over the same stored state gives the same answers, whoever asks.
// ---------------------------------------------------------------------------

/** What the dedup layers read from an incoming row. */
export type DedupRow = {
  date: string
  amount: number
  description: string
  external_id: string
  currency?: string | null
  import_source?: string | null
  bank_connection_id?: string | null
  /** The bank's own id for the row, when the feed sent one. */
  provider_transaction_id?: string | null
}

/**
 * Stable (date, öre, index) ids name a transaction only while its bucket's set
 * of rows never changes; a late-booked sibling would otherwise take a stored
 * row's index and be skipped as a duplicate. Re-key them against the stored
 * rows before any dedup layer runs (see reconcileStableExternalIds). Returns
 * the rows in input order; a row whose id did not move is returned as is.
 *
 * @param stableExternalIds IngestOptions.stableExternalIds
 */
export function rekeyIncomingExternalIds<T extends DedupRow>(
  rows: T[],
  existingMaps: ExistingTransactionMaps,
  stableExternalIds = false,
): T[] {
  // An id that IS the booking's identity is never re-keyed: pairing it with a
  // stored row by description would turn a new booking into a Layer-1 hit.
  if (stableExternalIds) return rows
  const reconciledIds = reconcileStableExternalIds(
    rows.map((raw) => ({
      external_id: raw.external_id,
      description: normalizeImportedDescription(raw.description),
      source: raw.import_source ?? null,
      bankConnectionId: raw.bank_connection_id ?? null,
      providerTransactionId: raw.provider_transaction_id ?? null,
    })),
    [...existingMaps.booked.values(), ...existingMaps.unbookedImported.values()].flat(),
  )
  return rows.map((raw, i) =>
    reconciledIds[i] === raw.external_id ? raw : { ...raw, external_id: reconciledIds[i] })
}

/**
 * A uuid in an `.in()` list in the query string: its 36 characters and the
 * encoded comma (%2C) after it. ID_READ_CHUNK of them are the room one read
 * may take.
 */
const UUID_IN_LIST_LENGTH = 39

/**
 * What one value takes in an `.in()` list in the query string: supabase-js
 * quotes a value holding a comma or a parenthesis, and the list is
 * form-encoded, its commas included.
 */
function inListLength(value: string): number {
  const listed = /[,()]/.test(value) ? `"${value}"` : value
  return new URLSearchParams({ v: `${listed},` }).toString().length - 'v='.length
}

/**
 * A batch's external_ids in slices of one `.in()` read each. The ids travel
 * in the GET query string, and the gateway refuses a long one before
 * PostgREST sees it (ID_READ_CHUNK in lib/reconciliation/limits.ts). An
 * external_id is no uuid: a bank feed's runs to some 80 characters and the v1
 * API takes 200, so a slice holds as many as fit the room ID_READ_CHUNK uuids
 * take, counted by the batch's longest id, and never more than ID_READ_CHUNK.
 */
function externalIdSlices(externalIds: readonly string[]): string[][] {
  const longest = externalIds.reduce((max, id) => Math.max(max, inListLength(id)), UUID_IN_LIST_LENGTH)
  return chunk(externalIds, Math.max(1, Math.floor((ID_READ_CHUNK * UUID_IN_LIST_LENGTH) / longest)))
}

/**
 * Which of these external_ids are already stored for the company (Layer 1),
 * mapped to the stored row's id. Read in slices (externalIdSlices); a slice
 * answers at most one row per id (the unique index on (company_id,
 * external_id)), so none comes near PostgREST's 1000-row cap.
 *
 * Throws when a slice cannot be read, before any row is decided. Its rows
 * would otherwise count as new while their stored twins stay in the content
 * buckets (buildIngestDedupState reserves only the stored rows found here):
 * a genuinely new row of the same day, amount and text could then be taken
 * for one of those twins and never be imported, and the unique index only
 * turns back the re-read row itself. A bank sync whose batch fails keeps its
 * window, so the next sync reads the same rows again.
 */
export async function fetchStoredExternalIds(
  supabase: SupabaseClient,
  companyId: string,
  externalIds: string[],
): Promise<Map<string, string | null>> {
  const stored = new Map<string, string | null>()
  for (const ids of externalIdSlices(externalIds)) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, external_id')
      .eq('company_id', companyId)
      .in('external_id', ids)
    if (error) throw dbError(error, 'Stored external_id read failed')
    data?.forEach((r) => stored.set(r.external_id, r.id ?? null))
  }
  return stored
}

type BoundCashAccountRow = {
  id: string
  ledger_account: string
  iban: string | null
  currency: string
  enabled?: boolean | null
  bank_connection_id?: string | null
  invoice_payee?: boolean | null
}

/** The cash account a batch settles on, plus every row's physical key. */
export interface BatchCashAccount {
  cashAccountId: string | null
  boundRow: BoundCashAccountRow | null
  /** row id -> physicalAccountKey (IBAN + currency); rows without a key omitted. */
  physicalKeyById: Map<string, string>
  error: { message: string } | null
}

/**
 * Resolve the cash account a batch settles on. READ-ONLY: the commit path
 * re-enables a disabled account afterwards, a preview never does.
 *
 * Every row in one ingest call shares a settlement account: enable-banking
 * calls ingest per account (settlementAccount = account.ledger_account), CSV
 * import passes the single account the user picked. cash_accounts.ledger_account
 * is unique per company, so at most one row matches. A miss is tolerated: the
 * row stays unbound (cash_account_id NULL) and reconciliation falls back to
 * currency. Nothing is auto-created here: a caller that lets the user pick a
 * ledger (the bank-file execute route) runs ensureManualCashAccount first.
 *
 * The same read yields every row's physical key (IBAN + currency) for the
 * account guard: a broken reconnect leaves two rows for one bank account, and
 * comparing row ids alone made the content check treat them as two accounts
 * (see sameCashAccount). Without a settlement account the guard never rejects,
 * so the read is skipped.
 */
export async function readBatchCashAccount(
  supabase: SupabaseClient,
  companyId: string,
  settlementAccount: string | undefined,
): Promise<BatchCashAccount> {
  const account: BatchCashAccount = {
    cashAccountId: null,
    boundRow: null,
    physicalKeyById: new Map<string, string>(),
    error: null,
  }
  if (!settlementAccount) return account
  const { data: cashAccountRows, error: cashAccountError } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, iban, currency, enabled, bank_connection_id, invoice_payee')
    .eq('company_id', companyId)
  account.error = cashAccountError ?? null
  for (const row of (cashAccountRows ?? []) as BoundCashAccountRow[]) {
    if (row.ledger_account === settlementAccount) {
      account.cashAccountId = row.id
      account.boundRow = row
    }
    const key = physicalAccountKey(row)
    if (key) account.physicalKeyById.set(row.id, key)
  }
  return account
}

/** Everything decideIngestRow needs, fixed before the first row is decided. */
export interface IngestDedupState {
  existingMaps: ExistingTransactionMaps
  /** Stored external_id -> stored row id, for the ids this batch carries. */
  storedExternalIds: ReadonlyMap<string, string | null>
  cashAccountId: string | null
  physicalKeyById: ReadonlyMap<string, string>
  /** The first row's import_source: every row in one call shares a channel. */
  batchSource: string | null
  batchIsImportFeed: boolean
  /** IngestOptions.stableExternalIds: the batch's ids identify bookings. */
  stableExternalIds: boolean
  /** Incoming rows per (date, öre) bucket (import-feed batches only). */
  incomingByBucket: Map<string, number>
  /** Stored rows from a DIFFERENT feed per bucket (import-feed batches only). */
  crossSourceStoredByBucket: Map<string, number>
  /** Incoming rows Layer 1 will not reconcile, per bucket (import-feed batches only). */
  unmatchedIncomingByBucket: Map<string, number>
  /** Guarded booked hand-entered candidates per bucket (import-feed batches only). */
  bookedHandEnteredByBucket: Map<string, number>
}

/**
 * Fix the per-batch facts the row decisions depend on. Pure; it mutates
 * `existingMaps` once, to reserve the stored rows Layer 1 accounts for.
 *
 * Every row in one ingest call shares an import_source (EB sync passes
 * 'enable_banking', bank-file import passes 'csv_<format>'/'camt053'), so the
 * first row's source identifies this batch's channel. We use it to find
 * "cross-channel mirror" buckets: a (date, öre) bucket where the number of
 * incoming rows EQUALS the number of stored rows from a DIFFERENT feed. That
 * equality is the signal that the same set of real transactions is arriving
 * once per channel (e.g. Nordea's CSV export and its PSD2 feed), where the
 * per-row description is known-unreliable: CSV shows the payee, PSD2 the
 * OCR/message, or vice versa. Only in those buckets do we dedup on
 * (date, öre, account) without a description match (see decideIngestRow).
 * An asymmetric bucket keeps the description requirement, so a genuinely-new
 * row is never collapsed into a different one.
 *
 * The same count-symmetry signal also runs against BOOKED hand-entered rows
 * (import_source manual/mcp/null): a user who bookkeeps by chat/MCP first and
 * connects the bank afterwards has already put the movement in the ledger,
 * and the feed's copy of it must not re-appear as a duplicate. This mirror is
 * gated harder than feed-vs-feed: the stored row must be BOOKED (staged/
 * unbooked hand-entered rows never consume an import), its currency must not
 * contradict the incoming row's, its cash account must be compatible, and the
 * bucket counts must match exactly. Tracked in a SEPARATE count map so the
 * feed-vs-feed mirror semantics are untouched: a hand-entered twin never
 * breaks feed count symmetry.
 */
export function buildIngestDedupState(input: {
  /** Incoming rows, already re-keyed (rekeyIncomingExternalIds). */
  rows: DedupRow[]
  existingMaps: ExistingTransactionMaps
  storedExternalIds: ReadonlyMap<string, string | null>
  cashAccountId: string | null
  physicalKeyById: ReadonlyMap<string, string>
  /** IngestOptions.stableExternalIds */
  stableExternalIds?: boolean
}): IngestDedupState {
  const { rows, existingMaps, storedExternalIds, cashAccountId, physicalKeyById } = input
  const batchSource = rows[0]?.import_source ?? null
  const batchIsImportFeed = isImportedTransaction({ import_source: batchSource })
  const incomingByBucket = new Map<string, number>()
  const crossSourceStoredByBucket = new Map<string, number>()
  const incomingCurrencyByBucket = new Map<string, string | null | typeof MIXED_CURRENCIES>()
  if (batchIsImportFeed) {
    for (const raw of rows) {
      const k = contentBucketKey(raw.date, raw.amount)
      incomingByBucket.set(k, (incomingByBucket.get(k) ?? 0) + 1)
      const cur = raw.currency ?? null
      if (!incomingCurrencyByBucket.has(k)) incomingCurrencyByBucket.set(k, cur)
      else if (incomingCurrencyByBucket.get(k) !== cur) incomingCurrencyByBucket.set(k, MIXED_CURRENCIES)
    }
    for (const bucket of [existingMaps.booked, existingMaps.unbookedImported]) {
      for (const [k, entries] of bucket) {
        for (const entry of entries) {
          // A row the feed reads as not booked is no mirror twin (see decideIngestRow).
          if (entry.isImportFeed && entry.source !== batchSource && !entry.notBooked) {
            crossSourceStoredByBucket.set(k, (crossSourceStoredByBucket.get(k) ?? 0) + 1)
          }
        }
      }
    }
  }

  // A stored row an incoming id names is accounted for by Layer 1: take it out
  // of the content buckets BEFORE any row is decided, so no other incoming row
  // (earlier in the batch or later) can also be deduped against it. Counting
  // semantics then hold across both layers, independent of batch order.
  for (const raw of rows) {
    if (storedExternalIds.has(raw.external_id)) consumeByExternalId(existingMaps, raw.external_id)
  }

  // Incoming rows Layer-1 will NOT reconcile (their external_id is not already
  // stored): the honest per-bucket count of rows that will actually reach the
  // content-dedup layer. The hand-entered mirror's symmetry check uses it: the
  // coarse incomingByBucket would let a Layer-1 duplicate inflate the count.
  const unmatchedIncomingByBucket = new Map<string, number>()
  if (batchIsImportFeed) {
    for (const raw of rows) {
      if (!storedExternalIds.has(raw.external_id)) {
        const k = contentBucketKey(raw.date, raw.amount)
        unmatchedIncomingByBucket.set(k, (unmatchedIncomingByBucket.get(k) ?? 0) + 1)
      }
    }
  }

  // ── Booked-hand-entered mirror candidates ────────────────────────────────
  // Counted with the SAME guards the consume step applies (account
  // compatibility + currency). Counting entries the consume step would reject
  // makes "symmetry" lie: an unconsumable twin could switch the mirror on and
  // collapse a genuinely-new row. Hand-entered candidates exist ONLY in the
  // booked map: the unbooked map's query excludes manual/mcp/null sources at
  // the DB level.
  const bookedHandEnteredByBucket = new Map<string, number>()
  if (batchIsImportFeed) {
    for (const [k, entries] of existingMaps.booked) {
      const bucketCurrency = incomingCurrencyByBucket.get(k)
      // No incoming rows in this bucket, or the incoming rows disagree on
      // currency: the currency gate cannot be evaluated per-bucket, so the
      // hand-entered mirror stays off there (conservative: row inserts).
      if (bucketCurrency === undefined || bucketCurrency === MIXED_CURRENCIES) continue
      for (const entry of entries) {
        if (entry.isImportFeed) continue
        const accountCompatible = sameCashAccount(cashAccountId, entry.cashAccountId, physicalKeyById)
        if (!accountCompatible) continue
        if (entry.currency !== null && bucketCurrency !== null && entry.currency !== bucketCurrency) continue
        bookedHandEnteredByBucket.set(k, (bookedHandEnteredByBucket.get(k) ?? 0) + 1)
      }
    }
  }

  return {
    existingMaps,
    storedExternalIds,
    cashAccountId,
    physicalKeyById,
    batchSource,
    batchIsImportFeed,
    stableExternalIds: input.stableExternalIds === true,
    incomingByBucket,
    crossSourceStoredByBucket,
    unmatchedIncomingByBucket,
    bookedHandEnteredByBucket,
  }
}

/**
 * Identity beats content. True when the ids alone prove that a stored row is
 * a DIFFERENT booking than the incoming one, however alike the two look.
 *
 * That takes two facts. The feed has stated that its external_ids are the
 * source's own per-booking references (IngestOptions.stableExternalIds), and
 * the stored row was named by the same feed under another id. The feed would
 * have re-sent that stored booking under the id it is stored with, and Layer 1
 * would have caught it; an id never seen before is therefore a booking never
 * seen before. A bank that books several identical fees on one day, each with
 * its own reference, is the case: the third fee arriving a day later is not a
 * copy of the first two.
 *
 * "The same feed" is the same import-feed import_source and the same bank
 * connection (both null for file imports and API feeds). The connection is
 * part of it because a provider's ids are often minted per consent: after a
 * reconnect, or once the old connection is gone, the old rows are another
 * namespace and dedup on content again.
 *
 * Where the ids cannot speak, this is false and content plus count decide as
 * before: a stored row from another channel (a bank file, another provider, a
 * booked hand-entered row), a stored row without an id, and every feed that
 * has not made the statement (ids derived from content or position can change
 * for the same booking, which is exactly what the bridge is for).
 */
export function isOtherBookingOfSameFeed(
  state: Pick<IngestDedupState, 'stableExternalIds'>,
  raw: Pick<DedupRow, 'external_id' | 'import_source' | 'bank_connection_id'>,
  entry: Pick<BucketEntry, 'source' | 'externalId' | 'bankConnectionId'>,
): boolean {
  if (!state.stableExternalIds) return false
  const feed = raw.import_source ?? null
  // No feed label, no namespace: a source-less or hand-entered batch shares
  // its (absent) label with rows typed in by hand.
  if (!isImportedTransaction({ import_source: feed })) return false
  return (
    entry.source === feed &&
    (entry.bankConnectionId ?? null) === (raw.bank_connection_id ?? null) &&
    entry.externalId !== null &&
    entry.externalId !== raw.external_id
  )
}

/** What the pipeline will do with one incoming row. */
export type IngestRowDecision =
  | { skip: false }
  | {
      skip: true
      reason: IngestSkipReason
      /** The stored row that stands for the incoming one. */
      matchedExternalId: string | null
      matchedTransactionId: string | null
      /** The consumed content twin; null for an external_id match. */
      twin: BucketEntry | null
    }

/**
 * Decide one incoming row: insert it, or skip it as already stored. Rows must
 * be decided in input order, each exactly once: a content match CONSUMES its
 * stored twin.
 *
 * 1. Layer 1: the row's external_id is already stored.
 *
 * 1b/1c. Content-dedup bridge: skip if an existing booked row (any source)
 * OR an unbooked import-feed row shares this (date, öre) bucket and EITHER
 * (a) a *bridging* description (prefix-containment, see descriptionsBridge),
 * OR (b) the bucket is a cross-channel mirror (crossSourceMirror below),
 * OR (c) the bucket is a booked-hand-entered mirror (handEnteredMirror).
 * (a) catches re-imports the external_id check misses: old-format ids
 * re-synced after the id scheme changed, and PSD2 description enrichment
 * between syncs ("TIC" → "TIC  BG … via internet"). (b) catches the same
 * bank account imported via two channels whose descriptions don't bridge at
 * all (Nordea CSV payee "TELENOR"/"Nordea" vs PSD2 OCR/message), which (a)
 * alone cannot. (c) catches the feed delivering a movement the user already
 * booked by hand (MCP/manual) under a free-form title that shares no text
 * with the bank's ("Egen insättning …" vs "TRANSFER-123 Topped up").
 * Booked first, then unbooked.
 *
 * Consumed with COUNTING semantics: each match splices one stored entry out
 * of its bucket, so N stored twins dedup exactly N incoming and two
 * genuinely-distinct same-(date,amount) transactions are kept apart. The
 * text bridge is tried first (LONGEST bridging description wins, so a
 * more-specific twin is matched before a generic one); the cross-channel
 * mirror is the text-independent fallback.
 *
 * Account guard: when BOTH the incoming batch and a stored entry have a known
 * cash_account_id, they must be the same bank account (same row, or two rows
 * sharing IBAN + currency: sameCashAccount), so a transaction on one bank account
 * never deduplicates a genuinely-different one on another account of the same
 * company (the content bucket is company-wide; only external_id embeds the
 * account). A null on either side falls back to bridge-allowed, leaving
 * single-account and legacy (un-backfilled) rows exactly as before. The guard
 * applies to BOTH the text and the cross-channel-mirror path.
 *
 * Currency guard: same shape, same null-tolerance, applied to all three
 * match paths. The bucket key carries no currency, so 250,00 EUR and
 * 250,00 SEK on one date share a bucket; without this an incoming row in
 * one currency consumes a stored row in another and the survivor is never
 * bokförd. A null on either side stays compatible (legacy rows).
 *
 * crossSourceMirror: this (date, öre) bucket holds the same number of
 * incoming rows as stored rows from a different feed → the same real
 * transactions arriving once per channel. Only then is the description
 * requirement dropped; an asymmetric bucket keeps it, so when the channels
 * disagree on how many transactions a bucket holds we keep a visible
 * (deletable) duplicate rather than risk collapsing a genuinely-new row.
 *
 * handEnteredMirror: the analogous signal against BOOKED hand-entered rows
 * (manual/mcp/null source). A booked hand-entered row means the user
 * already put this movement in the ledger before the feed delivered the
 * bank's copy (bookkeep-by-chat first, connect the bank later). Symmetry
 * compares the bucket's Layer-1-UNMATCHED incoming count (a row Layer-1
 * reconciles never reaches this layer, so it must not inflate the count)
 * against the guarded hand-entered candidate count, plus a per-entry
 * currency gate (the bucket key is only date+öre, and hand-entered rows
 * often lack a cash_account_id for the account guard to bite on).
 *
 * Identity guard: a stored row the ids prove to be another booking of the
 * same feed is never a twin (isOtherBookingOfSameFeed). It only ever removes
 * same-feed entries, so it narrows the text bridge and leaves both mirrors,
 * which match other channels, as they were.
 *
 * Not-booked guard: a stored row the batch's feed reads as not booked
 * (BucketEntry.notBooked, a card hold another feed stored, crm#2076) is no
 * cross-channel mirror twin and is not counted for the mirror's symmetry. Only
 * a bridging text can still take it, as when the hold itself is read again.
 *
 * @param description the row's normalized description (normalizeImportedDescription)
 */
export function decideIngestRow(
  state: IngestDedupState,
  raw: DedupRow,
  description: string,
): IngestRowDecision {
  const {
    existingMaps, storedExternalIds, cashAccountId, physicalKeyById, batchSource, batchIsImportFeed,
    incomingByBucket, crossSourceStoredByBucket, unmatchedIncomingByBucket, bookedHandEnteredByBucket,
  } = state

  // 1. Check for duplicates via external_id (batch pre-fetched)
  if (storedExternalIds.has(raw.external_id)) {
    return {
      skip: true,
      reason: 'external_id_match',
      matchedExternalId: raw.external_id,
      matchedTransactionId: storedExternalIds.get(raw.external_id) ?? null,
      twin: null,
    }
  }

  const bucketKey = contentBucketKey(raw.date, raw.amount)
  const rawCurrency = raw.currency ?? null
  const crossSourceMirror =
    batchIsImportFeed &&
    (crossSourceStoredByBucket.get(bucketKey) ?? 0) > 0 &&
    incomingByBucket.get(bucketKey) === crossSourceStoredByBucket.get(bucketKey)
  const handEnteredMirror =
    batchIsImportFeed &&
    (bookedHandEnteredByBucket.get(bucketKey) ?? 0) > 0 &&
    unmatchedIncomingByBucket.get(bucketKey) === bookedHandEnteredByBucket.get(bucketKey)
  const consumeBridgingTwin = (bucket: DescBucket): BucketEntry | null => {
    const entries = bucket.get(bucketKey)
    if (!entries || entries.length === 0) return null
    let bestIdx = -1
    let bestLen = -1
    let crossIdx = -1
    let handIdx = -1
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const sameAccount = sameCashAccount(cashAccountId, entry.cashAccountId, physicalKeyById)
      if (!sameAccount) continue
      // Currency guard, applies to ALL THREE match paths below. The bucket key
      // is (date, öre) with no currency, so a stored 250,00 SEK row and an
      // incoming 250,00 EUR row on the same date land in the SAME bucket; the
      // text bridge (identical bank titles) or the cross-channel mirror would
      // then consume one for the other and the survivor is silently never
      // bokförd (BFL 5 kap: a real affärshändelse dropped without a trace).
      // Two channels reporting the SAME movement always agree on the booked
      // amount's currency, so a mismatch here means two different movements
      // whose öre happen to coincide. Null on either side is compatible:
      // rows predating the currency column, and feeds that send none, must
      // dedup exactly as they did before this guard existed.
      const sameCurrency =
        entry.currency === null || rawCurrency === null || entry.currency === rawCurrency
      if (!sameCurrency) continue
      // Identity guard: the feed's own ids say this stored row is another
      // booking. Dropping the incoming row against it would lose a real
      // movement, so it is not a candidate on any path.
      if (isOtherBookingOfSameFeed(state, raw, entry)) continue
      if (descriptionsBridge(description, entry.desc) && entry.desc.length > bestLen) {
        bestIdx = i
        bestLen = entry.desc.length
      }
      // Text-independent fallback: in a cross-channel mirror bucket a stored
      // entry from a different feed is the same transaction even when the
      // descriptions don't bridge. Remember the first eligible one.
      if (crossIdx === -1 && crossSourceMirror && entry.isImportFeed && entry.source !== batchSource && !entry.notBooked) {
        crossIdx = i
      }
      // Booked-hand-entered fallback: hand-entered entries only exist in the
      // booked map (the unbooked query excludes manual/mcp at the DB level),
      // so !isImportFeed here already implies booked. The currency
      // requirement this path used to carry on its own is now the loop-level
      // `sameCurrency` guard above, which every match path shares.
      if (handIdx === -1 && handEnteredMirror && !entry.isImportFeed) {
        handIdx = i
      }
    }
    const idx = bestIdx !== -1 ? bestIdx : crossIdx !== -1 ? crossIdx : handIdx
    if (idx === -1) return null
    const [consumed] = entries.splice(idx, 1)
    return consumed
  }
  const bookedTwin = consumeBridgingTwin(existingMaps.booked)
  const twin = bookedTwin ?? consumeBridgingTwin(existingMaps.unbookedImported)
  if (!twin) return { skip: false }
  return {
    skip: true,
    reason: bookedTwin ? 'content_match_booked' : 'content_match_unbooked',
    matchedExternalId: twin.externalId,
    matchedTransactionId: twin.id,
    twin,
  }
}

// ---------------------------------------------------------------------------
// Update on re-read (Open Payments)
//
// The bank enriches an account's transactions once a day (ISO/Bankgirot
// enrichment: payer names, organisationsnummer, OCR references). The sync
// re-reads a 7-day window and dedupes on the stored key, so a row imported
// before that day's enrichment ran comes back richer and used to be skipped
// with everything the bank had added. A Layer-1 duplicate of that feed now
// updates the stored row's enrichable fields; its identity (amount, date, the
// bank's text) and its booking state are never touched.
// ---------------------------------------------------------------------------

/** The stored columns an Open Payments re-read may change. */
export type EnrichmentPatch = Partial<
  Pick<
    Transaction,
    | 'reference'
    | 'merchant_name'
    | 'counterparty_account'
    | 'counterparty_iban'
    | 'counterparty_org_number'
    | 'end_to_end_id'
    | 'mcc_code'
    | 'instructed_amount'
    | 'instructed_currency'
    | 'exchange_rate'
    | 'balance_after'
    | 'is_enriched'
    | 'enriched_at'
  >
>

/**
 * The stored rows the batch's external ids name, whole, for the update on
 * re-read. Only read for an Open Payments batch, and only for the ids Layer 1
 * found stored. Read in slices like fetchStoredExternalIds, and throws like
 * it when a slice cannot be read.
 */
export async function fetchStoredEnrichmentRows(
  supabase: SupabaseClient,
  companyId: string,
  externalIds: string[],
): Promise<Map<string, Transaction>> {
  const rows = new Map<string, Transaction>()
  for (const ids of externalIdSlices(externalIds)) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .in('external_id', ids)
    if (error) throw dbError(error, 'Stored row read for the re-read failed')
    for (const row of (data ?? []) as Transaction[]) {
      if (row.external_id) rows.set(row.external_id, row)
    }
  }
  return rows
}

const sameOre = (a: number | string | null | undefined, b: number | string | null | undefined): boolean =>
  a != null && b != null && amountToOre(a) === amountToOre(b)

/**
 * What a re-read row adds to its stored row, and whether a matching key
 * changed (the reference, the end-to-end id or the counterparty), which is
 * what warrants re-running the suggestion passes. Pure.
 *
 * The rules: the reference when the bank now sends one that differs; the
 * counterparty's name likewise when the stored name came from the same feed
 * (a bank may name only the payment type before its daily enrichment,
 * "UTLANDSBETALNING" or "KORT", and the payee after: PH 196), while a name
 * another feed stored stands; the counterparty's account, IBAN and
 * organisationsnummer, the end-to-end id and the merchant category only
 * where the stored row has none (the bank's first word stands); the
 * instructed amount and currency of a foreign purchase, the balance after
 * and the enriched flag whenever the bank reports them; the bank's rate in
 * exchange_rate only on a SEK account (a foreign-currency account keeps the
 * Riksbanken SEK rate there). enriched_at is `now` when the flag turns true;
 * a true flag never turns false again. NEVER: amount, date, description,
 * original_description, title_edited_at, any booking anchor, is_ignored,
 * category.
 */
export function enrichmentPatch(
  stored: Transaction,
  raw: RawTransaction,
  now: string,
): { patch: EnrichmentPatch | null; keysChanged: boolean } {
  const patch: EnrichmentPatch = {}
  let keysChanged = false
  const text = (value: string | null | undefined): string | null => {
    const trimmed = (value ?? '').trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const reference = text(raw.reference)
  if (reference !== null && reference !== (stored.reference ?? null)) {
    patch.reference = reference
    keysChanged = true
  }
  const fillKey = (
    column: 'merchant_name' | 'counterparty_account' | 'counterparty_iban' | 'counterparty_org_number' | 'end_to_end_id',
    value: string | null,
  ) => {
    if (value !== null && (stored[column] ?? null) === null) {
      patch[column] = value
      keysChanged = true
    }
  }
  // No person edits merchant_name (only the feeds write it), so the feed's
  // later word replaces its own earlier one, as the reference does. A name
  // another feed stored (an Enable Banking row the Open Payments re-read
  // meets after a switch) is only filled where it is missing.
  const merchantName = text(raw.merchant_name)
  const sameFeed = Boolean(stored.import_source) && stored.import_source === raw.import_source
  if (merchantName !== null && sameFeed && text(stored.merchant_name) !== merchantName) {
    patch.merchant_name = merchantName
    keysChanged = true
  } else {
    fillKey('merchant_name', merchantName)
  }
  fillKey('counterparty_account', text(raw.counterparty_account))
  fillKey('counterparty_iban', text(raw.counterparty_iban))
  fillKey('counterparty_org_number', text(raw.counterparty_org_number))
  fillKey('end_to_end_id', text(raw.end_to_end_id))
  if (stored.mcc_code == null && raw.mcc_code != null) patch.mcc_code = raw.mcc_code

  const rowCurrency = (raw.currency || stored.currency || 'SEK').toUpperCase()
  const instructedCurrency = text(raw.instructed_currency)?.toUpperCase() ?? null
  if (raw.instructed_amount != null && instructedCurrency !== null && instructedCurrency !== rowCurrency) {
    if (!sameOre(stored.instructed_amount, raw.instructed_amount)) patch.instructed_amount = raw.instructed_amount
    if ((stored.instructed_currency ?? null) !== instructedCurrency) patch.instructed_currency = instructedCurrency
    if (rowCurrency === 'SEK' && raw.exchange_rate != null && Number(stored.exchange_rate) !== raw.exchange_rate) {
      patch.exchange_rate = raw.exchange_rate
    }
  }
  if (raw.balance_after != null && !sameOre(stored.balance_after, raw.balance_after)) patch.balance_after = raw.balance_after
  if (raw.is_enriched != null && raw.is_enriched !== (stored.is_enriched ?? null) && stored.is_enriched !== true) {
    patch.is_enriched = raw.is_enriched
    if (raw.is_enriched) patch.enriched_at = now
  }
  return { patch: Object.keys(patch).length > 0 ? patch : null, keysChanged }
}

/**
 * The unique index on (company_id, external_id) refusing an insert: the id
 * was stored after the Layer-1 pre-fetch read the batch's ids. Matched by
 * index name, like the other named-index checks (supplier-invoices/create.ts),
 * so no other constraint is ever read as a duplicate.
 */
function isExternalIdConflict(error: { code?: string | null; message?: string | null } | null): boolean {
  return error?.code === '23505' && (error.message ?? '').includes('idx_transactions_company_external_id')
}

/**
 * Generic transaction ingestion pipeline.
 *
 * Handles:
 * 1. Deduplication via external_id. An Open Payments row that dedupes here
 *    against a stored row and arrives richer (the bank's daily enrichment)
 *    UPDATES the stored row's enrichable fields (enrichmentPatch) and, when
 *    the row is still open and a matching key changed, gets the matchers
 *    that take a re-read again. Counted in `enriched_updated`.
 * 1b. Content-based dedup (date+amount+description prefix) against already-booked
 *     transactions: catches cross-source duplicates, e.g. PSD2 row gets booked
 *     before the user later re-imports the same period via CSV.
 * 1c. Content-based dedup against unbooked enable_banking rows: catches PSD2
 *     reconnect duplicates AND CSV imports overlapping an active PSD2 sync (the
 *     description-prefix component makes this safe to apply across sources).
 *     Steps 1 to 1c are one decision (decideIngestRow), shared with the
 *     read-only previews, and every skipped row is named in the result
 *     (`skipped`, `duplicates_by_reason`): never only counted.
 * 2. Insert into transactions table, then the Bankgirot split of the row
 * 3. The suggestion passes: the ingest matchers in their order (customer
 *    invoice, payment order debit, supplier invoice heuristics, ROT/RUT
 *    payout and payout set; lib/composition/ingest-matchers.ts)
 * 4. Mapping rule evaluation for auto-categorization
 * 5. Auto-journal-entry creation for high-confidence matches
 *
 * Used by both bank file import and Enable Banking PSD2 sync.
 */
export async function ingestTransactions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  rawTransactions: RawTransaction[],
  options?: IngestOptions
): Promise<IngestResult> {
  // A bank-feed row only ever lands on the cash account its route resolved,
  // and that account has one currency. A row in another currency is set aside
  // and counted, never inserted there; it no longer fails the whole batch,
  // which left every other row of the sync out with it (crm#1767: a wallet
  // with no fixed currency, Svea's foreign card purchases before that). A
  // batch for another connection or ledger account is a caller bug and still
  // throws.
  let otherCurrency: Record<string, number> | null = null
  if (options?.bankRoute) {
    const route = options.bankRoute
    if (options.settlementAccount !== route.ledgerAccount || rawTransactions.some(raw =>
      raw.bank_connection_id !== route.connectionId)) {
      throw new Error('Bank ingest context does not match the fetched batch')
    }
    const inRouteCurrency: RawTransaction[] = []
    for (const raw of rawTransactions) {
      const currency = raw.currency?.trim().toUpperCase() || 'NONE'
      if (currency === route.currency) {
        inRouteCurrency.push(raw)
        continue
      }
      otherCurrency ??= {}
      otherCurrency[currency] = (otherCurrency[currency] ?? 0) + 1
    }
    rawTransactions = inRouteCurrency
  }
  const duplicatesByReason: Record<IngestSkipReason, number> = {
    external_id_match: 0,
    content_match_booked: 0,
    content_match_unbooked: 0,
  }
  const skipped: IngestSkippedRow[] = []
  const result: IngestResult = {
    imported: 0,
    duplicates: 0,
    duplicates_by_reason: duplicatesByReason,
    skipped,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: [],
    enriched_updated: 0,
  }
  // Every row that is not inserted because it is judged already stored goes
  // through here, so the count, the per-reason split and the per-row list can
  // never disagree. `externalId` is the id the caller sent (before re-keying).
  const recordSkip = (
    externalId: string,
    reason: IngestSkipReason,
    matchedExternalId: string | null,
    matchedTransactionId: string | null,
  ) => {
    result.duplicates++
    duplicatesByReason[reason]++
    skipped.push({
      external_id: externalId,
      reason,
      matched_external_id: matchedExternalId,
      matched_transaction_id: matchedTransactionId,
    })
  }

  const log = createLogger('transactions.ingest', { companyId })
  if (otherCurrency) {
    result.other_currency = otherCurrency
    // Codes and counts only, never an amount.
    log.warn('bank rows in another currency than the account set aside', {
      connectionId: options?.bankRoute?.connectionId,
      accountCurrency: options?.bankRoute?.currency,
      otherCurrency,
      kept: rawTransactions.length,
    })
  }

  // What each suggestion pass did in this batch: the baseline a per-company
  // package switch is measured against. Counts only, never ids or amounts.
  // `explained`: the pass settled or hinted the row and the passes after it
  // were skipped; `hinted`: a weak hint, the next passes still ran; `failed`:
  // the pass threw and the batch went on.
  const passHits: Record<string, { explained: number; hinted: number; failed: number }> = {}
  const tallyPass = (pass: string, outcome: 'explained' | 'hinted' | 'failed') => {
    const hits = (passHits[pass] ??= { explained: 0, hinted: 0, failed: 0 })
    hits[outcome]++
  }
  let rereadPasses = 0

  // Pre-fetch existing transactions for content-based dedup (date+amount+
  // description prefix, plus the cross-channel mirror below). Booked rows catch
  // cross-source duplicates after they've been booked; unbooked import-feed rows
  // catch the common case where a PSD2 row is still unbooked when the user
  // re-imports the same period via CSV, or the reverse, a CSV import that
  // predates the first PSD2 sync of the same account.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, rawTransactions, options?.isNotBooked)

  // Re-key stable (date, öre, index) ids against the stored rows before any
  // dedup layer runs. The ids the caller sent are kept for the per-row report.
  const submittedExternalIds = rawTransactions.map((raw) => raw.external_id)
  rawTransactions = rekeyIncomingExternalIds(rawTransactions, existingMaps, options?.stableExternalIds)

  // What the split and the suggestion passes (the ingest matchers,
  // lib/composition/ingest-matchers.ts) share for this batch: what each row
  // claimed, so no two rows are offered the same invoice, order or begäran,
  // and the open invoice pools.
  const claims = createIngestClaims()
  // Behind INGEST_PACKAGE_GATING (off: no read, every matcher runs): the
  // packages switched off with nothing open skip their matchers, and the
  // pools only those matchers read stay empty (lib/transactions/
  // ingest-package-gate.ts). Read once for the batch; a failed read skips
  // nothing. A package that is winding down keeps every matcher.
  const gate = ingestPackageGatingEnabled()
    ? await readIngestPackageGate(supabase, companyId, INGEST_MATCHERS)
    : RUN_EVERY_MATCHER
  // Open customer invoices for income matching: read once for the batch, on
  // the first income row (an all-expense batch never reads them), instead of
  // once per row. Nothing in this loop changes an invoice or its payments, so
  // every row scores against what it would have read itself. A failed read is
  // not kept: the next income row tries again, as each row used to.
  let invoiceMatchPool: InvoiceMatchPool | null = gate.skips(INGEST_POOL_OWNERS.customerInvoices) ? { invoices: [] } : null
  const batch: IngestBatch = {
    supabase,
    companyId,
    userId,
    options: options ?? {},
    log,
    result,
    claims,
    pools: {
      customerInvoices: async () => (invoiceMatchPool ??= await OPEN_INVOICES.loadCustomerInvoicePool(supabase, companyId)),
      supplierInvoices: [],
    },
    logMatch(transactionId, action, opts) {
      return logMatchEvent(supabase, userId, transactionId, action, opts)
    },
  }
  const matchers = startIngestMatchers(gateIngestMatchers(INGEST_MATCHERS, gate), batch, tallyPass)

  // Keyed by `${currency}|${date}` so each non-SEK transaction gets the
  // rate that was valid on its own transaction date, not the import date.
  const exchangeRatesByDate = new Map<string, ExchangeRate>()

  // When rawInsertOnly is set (viewer imports), skip pre-fetching supplier
  // invoices, the matchers' reads and exchange rates: they are not used.
  if (!options?.rawInsertOnly) {
  // Pre-fetch unpaid supplier invoices for expense matching (non-critical).
  // A gate that skips their package leaves the pool empty, unread.
  if (!gate.skips(INGEST_POOL_OWNERS.supplierInvoices)) {
    try {
      batch.pools.supplierInvoices = await fetchAllRows<SupplierInvoice>(({ from, to }) =>
        supabase
          .from('supplier_invoices')
          .select('*, supplier:suppliers(*)')
          .eq('company_id', companyId)
          .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
          .gt('remaining_amount', 0)
          .order('id', { ascending: true })
          .range(from, to)
      )
    } catch {
      // Non-critical: supplier invoice matching will be skipped
    }
  }
  // What each matcher reads once per batch: the open bank payment orders a
  // debit may settle, the open ROT/RUT begäran Skatteverket's payout may
  // answer. Never throws.
  await matchers.prepare()
  }

  // Pre-fetch exchange rates for each unique (currency, date) pair in the
  // batch. Riksbanken publishes a per-day rate; using one batched fetch with
  // no date stamps every row at today's rate, which is wrong for historical
  // imports (issue #442). fetchExchangeRate already falls back to the last
  // 7 days when the requested day is a weekend/holiday.
  //
  // Concurrency is bounded: a 90-day first-sync backfill of a foreign-
  // currency account used to fire every pair at Riksbanken simultaneously
  // and got the whole batch rate-limited. Passing `supabase` gives
  // fetchExchangeRate the persistent exchange_rates cache, so repeat dates
  // cost a DB lookup instead of an API call.
  if (!options?.rawInsertOnly) {
    const uniquePairs = new Map<string, { currency: Currency; date: string }>()
    for (const t of rawTransactions) {
      if (t.currency && t.currency !== 'SEK' && t.date) {
        const key = `${t.currency}|${t.date}`
        if (!uniquePairs.has(key)) {
          uniquePairs.set(key, { currency: t.currency as Currency, date: t.date })
        }
      }
    }

    if (uniquePairs.size > 0) {
      const pairs = Array.from(uniquePairs.entries())
      const RATE_FETCH_CONCURRENCY = 4
      for (let i = 0; i < pairs.length; i += RATE_FETCH_CONCURRENCY) {
        const chunk = pairs.slice(i, i + RATE_FETCH_CONCURRENCY)
        const settled = await Promise.allSettled(
          chunk.map(([, { currency, date }]) =>
            fetchExchangeRate(currency, new Date(date), supabase)
          )
        )
        for (let j = 0; j < chunk.length; j++) {
          const [key] = chunk[j]
          const outcome = settled[j]
          if (outcome.status === 'fulfilled' && outcome.value) {
            exchangeRatesByDate.set(key, outcome.value)
          }
          // A null/rejected outcome leaves the key unset: the transaction is
          // inserted without amount_sek/exchange_rate and remains repairable
          // via /api/transactions/[id]/refresh-exchange-rate. Rates are never
          // made up, fetchExchangeRate's last resort is the most recent
          // CACHED observation, not a hardcoded number.
        }
      }
    }
  }

  // Pre-fetch existing external_ids in batches for dedup (avoids N+1 queries)
  const externalIds = rawTransactions.map(t => t.external_id)
  const storedExternalIds = await fetchStoredExternalIds(supabase, companyId, externalIds)

  // The stored rows an Open Payments re-read may update (see enrichmentPatch):
  // whole, for the ids Layer 1 found stored. Other feeds skip their Layer-1
  // duplicates exactly as before and never pay for this read.
  // A failed read costs the update only: the re-read rows are skipped as the
  // duplicates they are, unchanged, and the next sync re-reads the same window.
  const storedIdsOfBatch = externalIds.filter((id) => storedExternalIds.has(id))
  let enrichable = new Map<string, Transaction>()
  if (feedRereadsStoredRows(INGEST_FEEDS, rawTransactions[0]?.import_source) && storedIdsOfBatch.length > 0) {
    try {
      enrichable = await fetchStoredEnrichmentRows(supabase, companyId, storedIdsOfBatch)
    } catch (error) {
      log.warn('stored rows of the re-read unreadable: the re-read rows stay as stored', {
        storedIds: storedIdsOfBatch.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Resolve the cash account this batch settled on, once (readBatchCashAccount).
  const batchAccount = await readBatchCashAccount(supabase, companyId, options?.settlementAccount)
  if (batchAccount.error && options?.bankRoute) {
    throw new Error(`Bank ingest account read failed: ${batchAccount.error.message}`)
  }
  const { cashAccountId, physicalKeyById } = batchAccount
  if (options?.settlementAccount) {
    // Every ingest caller binds here, including the ones that never run
    // ensureManualCashAccount (the v1 ingest endpoint). An account the company
    // turned off as unused comes back on before rows land on it, so a hidden
    // account never collects open transactions (desk crm#59). No-op for an
    // enabled account and for one a bank connection holds; refuses, binding
    // nothing, for a disabled invoice payee (owner/admin turns that on).
    if (options.bankRoute) {
      if (cashAccountId !== options.bankRoute.cashAccountId) throw new Error('Bank ingest account changed; reload the route')
    } else if (batchAccount.boundRow) {
      await reenableIfUnused(supabase, companyId, batchAccount.boundRow)
    }
  }

  // The per-batch facts every row decision depends on (reserves the stored
  // rows Layer 1 accounts for, counts the mirror buckets).
  const dedup = buildIngestDedupState({
    rows: rawTransactions,
    existingMaps,
    storedExternalIds,
    cashAccountId,
    physicalKeyById,
    stableExternalIds: options?.stableExternalIds,
  })

  /** Inserted inbound rows, for the collections payment-candidate sweep. */
  const inboundIds: string[] = []
  // The company's momskoder for auto-categorized reverse-charge rows: read
  // once for the whole ingestion, and only if such a row is booked.
  const loadChart = chartVatTreatmentsLoader(supabase, companyId)
  // A batch that names no settlement account (the v1 ingest and bank-file
  // endpoints called without one) binds each inserted row to the company's
  // default account in its currency: the rule the manual form and the MCP
  // door use (crm#1171). Read once per currency and connection. A named
  // account that resolves to no row (Stripe's 1580) stays unbound, and the
  // dedup above still treats the batch as unbound.
  const defaultCashAccountIds = new Map<string, Promise<string | null>>()
  const rowCashAccountId = (raw: RawTransaction): Promise<string | null> => {
    if (options?.settlementAccount) return Promise.resolve(cashAccountId)
    const currency = (raw.currency || 'SEK').toUpperCase()
    const connectionId = raw.bank_connection_id || null
    const key = `${currency}|${connectionId ?? ''}`
    let pending = defaultCashAccountIds.get(key)
    if (!pending) {
      pending = resolveDefaultCashAccount(supabase, companyId, currency, connectionId).then((account) => account?.id ?? null)
      defaultCashAccountIds.set(key, pending)
    }
    return pending
  }

  // The company's auto_book_customer_payments switch, read on the batch's
  // first deposit split it could book (DEPOSIT_SPLIT_BOOKING, crm#2226).
  let autoBookSwitch: Promise<boolean> | null = null
  const customerPaymentAutoBook = (): Promise<boolean> =>
    (autoBookSwitch ??= DEPOSIT_SPLIT_BOOKING.isOn(supabase, companyId).catch((error: unknown) => {
      log.warn('auto-book switch unreadable; deposit splits stay suggestions', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }))

  /**
   * The Bankgirot split of an Open Payments row (raw.parts), applied through
   * applyTransactionSplit (lib/transactions/parts-apply.ts, shared with the
   * BG Max import): store the parts
   * beside the row, replacing what it had, and suggest the open invoice
   * behind each part (OPEN_INVOICES) for a row a person has not yet
   * decided. When two or more parts all resolved and sum to the row, the row
   * is marked potential_match_method = 'bankgiro_split' and a single-invoice
   * hint it carried is cleared: the row pays several invoices, so the
   * one-click single match would only be refused. True exactly then, so the
   * caller skips the single-invoice passes and the mapping engine. A single
   * part keeps today's single-invoice path. A deposit whose every part names
   * its invoice by OCR is booked as one samlingsverifikat when the company
   * switched auto_book_customer_payments on; everything else is a
   * suggestion. A failure leaves the row as it was and never fails the batch.
   */
  const storePartsForRow = async (tx: Transaction, raw: RawTransaction): Promise<boolean> => {
    const parts = raw.parts
    if (!feedCarriesSplits(INGEST_FEEDS, raw.import_source) || !parts || parts.length === 0) return false
    try {
      const open =
        !options?.rawInsertOnly && !tx.journal_entry_id && !tx.invoice_id && !tx.supplier_invoice_id && !tx.is_ignored
      const customerPool = open && tx.amount > 0 ? await batch.pools.customerInvoices() : null
      const { suggestions, complete } = await applyTransactionSplit(supabase, {
        companyId,
        userId,
        tx,
        parts,
        pools: open
          ? {
              customerInvoices: tx.amount > 0 ? customerPool?.invoices ?? [] : [],
              supplierInvoices: tx.amount < 0 ? batch.pools.supplierInvoices : [],
              excludeInvoiceIds: claims.ids(tx.amount > 0 ? 'customer_invoice' : 'supplier_invoice'),
            }
          : null,
      })
      if (!complete || !suggestions) return false

      // The split claims its invoices for the batch: no other row's single
      // hint may name them, and a supplier invoice leaves the heuristics' pool.
      for (const s of suggestions) {
        if (s.suggested_invoice_id) claims.add('customer_invoice', s.suggested_invoice_id)
        if (s.suggested_supplier_invoice_id) {
          claims.add('supplier_invoice', s.suggested_supplier_invoice_id)
          batch.pools.supplierInvoices = batch.pools.supplierInvoices.filter((inv) => inv.id !== s.suggested_supplier_invoice_id)
        }
      }
      result.auto_matched_invoices++
      tallyPass('bankgiro-split', 'explained')
      if (customerPool) await autoBookSplit(tx, parts, suggestions, customerPool.invoices)
      return true
    } catch (error) {
      tallyPass('bankgiro-split', 'failed')
      log.warn('bank transaction parts not stored; the row keeps no split', {
        transactionId: tx.id,
        parts: parts.length,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /**
   * Book a complete deposit split whose every part names its invoice by OCR,
   * as one samlingsverifikat nobody confirmed, when the company asked for it.
   * A refusal or a failure leaves the split's suggestion as it is.
   */
  const autoBookSplit = async (
    tx: Transaction,
    parts: NonNullable<RawTransaction['parts']>,
    suggestions: Parameters<typeof DEPOSIT_SPLIT_BOOKING.allocations>[1],
    invoices: InvoiceMatchPool['invoices'],
  ): Promise<void> => {
    try {
      const allocations = DEPOSIT_SPLIT_BOOKING.allocations(parts, suggestions, invoices)
      if (!allocations || !(await customerPaymentAutoBook())) return
      const booked = await DEPOSIT_SPLIT_BOOKING.book({ supabase, companyId, userId, log }, tx.id, allocations)
      if (booked.ok) {
        result.auto_booked_payments = (result.auto_booked_payments ?? 0) + 1
        log.info('deposit split booked by its OCR references', {
          transactionId: tx.id,
          journalEntryId: booked.journalEntryId,
          parts: allocations.length,
        })
      } else {
        log.info('deposit split left as a suggestion', { transactionId: tx.id, code: booked.code })
      }
    } catch (error) {
      log.warn('deposit split auto-booking failed; the suggestion stands', {
        transactionId: tx.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * An Open Payments re-read of a stored row (Layer 1): write what the bank
   * added (enrichmentPatch), count it, store the split it carries
   * (storePartsForRow), and give a still-open row whose matching keys
   * changed the matchers that take a re-read (IngestMatcher.onReread).
   * Everything here is best effort: a failure leaves the row as it was and
   * never fails the batch, whose other rows are unrelated to it.
   */
  const enrichStoredRow = async (stored: Transaction, raw: RawTransaction): Promise<void> => {
    try {
      const { patch, keysChanged } = enrichmentPatch(stored, raw, new Date().toISOString())
      let merged: Transaction = stored
      if (patch) {
        const { error: updateError } = await supabase
          .from('transactions')
          .update(patch)
          .eq('id', stored.id)
          .eq('company_id', companyId)
        if (updateError) {
          log.warn('enrichment on re-read not stored; row kept as it was', {
            transactionId: stored.id,
            columns: Object.keys(patch),
            error: updateError.message,
          })
          return
        }
        result.enriched_updated = (result.enriched_updated ?? 0) + 1
        merged = { ...stored, ...patch }
      }
      // The split travels with the re-read whether or not the row's own
      // fields changed: the parts always mirror the bank's latest word.
      const completeSplit = await storePartsForRow(merged, raw)
      if (!patch || !keysChanged) return
      log.info('enrichment on re-read: matching keys changed', {
        transactionId: stored.id,
        columns: Object.keys(patch),
        booked: Boolean(stored.journal_entry_id || stored.invoice_id || stored.supplier_invoice_id),
      })
      // The passes only for a row a person has not yet decided: unbooked,
      // unlinked, not ignored, and not a viewer's raw import. A complete
      // split explained the row already.
      if (options?.rawInsertOnly || completeSplit) return
      if (merged.journal_entry_id || merged.invoice_id || merged.supplier_invoice_id || merged.is_ignored) return
      rereadPasses++
      await matchers.match({ tx: merged, raw, reread: true })
    } catch (error) {
      log.warn('enrichment on re-read failed; the batch continues', {
        transactionId: stored.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (let index = 0; index < rawTransactions.length; index++) {
    const raw = rawTransactions[index]
    // Normalize the source title once. Guarantees a non-empty, Swedish-first
    // label for every import path (PSD2 sync + all bank-file CSV/CAMT parsers
    // funnel into raw.description): catching both empty/whitespace titles and
    // the legacy English 'Unknown' sentinel. This normalized FULL value is what
    // the content-dedup key is built from and what original_description stores;
    // the row's working title (description column) is the classifier's
    // displayTitle: the same string with the trailing channel phrase
    // ("Överföring via internet", "Kortköp/uttag", ...) stripped. A stripped
    // title is a PREFIX of the full string, so the prefix-containment dedup
    // bridge is unaffected.
    const description = normalizeImportedDescription(raw.description)
    // Classification is a FEED-row concept: a user-created row (manual UI,
    // MCP, or a source-less caller without a bank connection) carries a
    // user-authored title, not bank channel vocabulary; classifying or
    // stripping it would corrupt meaning ("Egen insättning" is a title, not a
    // deposit label). Same predicate as isImportedTransaction(): a live
    // bank_connection_id marks a feed row even when import_source is unset.
    // Mirrors the scope of the 20260808090100 backfill.
    const isUserCreatedSource = !isImportedTransaction({
      bank_connection_id: raw.bank_connection_id ?? null,
      import_source: raw.import_source ?? null,
    })
    const { method: transactionMethod, displayTitle } = isUserCreatedSource
      ? { method: null, displayTitle: description }
      : classifyTransactionMethod({
          description,
          bankTransactionCode: raw.bank_transaction_code ?? null,
          proprietaryBankTransactionCode: raw.proprietary_bank_transaction_code ?? null,
          mccCode: raw.mcc_code ?? null,
          explicitMethod: raw.transaction_method ?? null,
        })

    // 1 + 1b/1c. Already stored? Layer 1 (external_id) and the content-dedup
    // bridge, decided by the function the previews share (decideIngestRow).
    const decision = decideIngestRow(dedup, raw, description)
    const bucketKey = contentBucketKey(raw.date, raw.amount)
    const rawCurrency = raw.currency ?? null
    if (decision.skip) {
      recordSkip(submittedExternalIds[index], decision.reason, decision.matchedExternalId, decision.matchedTransactionId)
      const consumedTwin = decision.twin
      // Layer-1 (external_id) duplicates are exact key collisions: the row
      // is stored. An Open Payments re-read may still carry the bank's daily
      // enrichment for it (enrichStoredRow); every other feed is done.
      if (!consumedTwin) {
        const stored = enrichable.get(raw.external_id)
        if (stored) await enrichStoredRow(stored, raw)
        continue
      }
      // Leave a trace of the drop. This layer drops a row on a judgement call
      // (text bridge / cross-channel mirror / hand mirror), and an incoming
      // row dropped here is never inserted and therefore never bokförd. The
      // result carries the same fact per row (result.skipped, with the reason
      // and the stored row it matched), which the v1 ingest response returns;
      // the dashboard and the bank sync show counts only, so this log stays
      // the operator's per-row record of WHICH affärshändelse was dropped and
      // against what.
      log.info('import dedup: content-bridge duplicate skipped', {
        decision: 'content-bridge',
        mode: 'enforced',
        reason: decision.reason,
        bucket: bucketKey,
        incomingExternalId: raw.external_id,
        incomingDescription: description,
        incomingAmount: raw.amount,
        incomingCurrency: rawCurrency,
        incomingSource: raw.import_source ?? null,
        cashAccountId,
        matchedStoredId: consumedTwin.id,
        matchedStoredExternalId: consumedTwin.externalId,
        // With incomingSource this tells a same-feed absorption (the kind
        // that loses a movement when the feed's ids are identities) from a
        // cross-channel one (a re-import through another door).
        matchedStoredSource: consumedTwin.source,
        matchedStoredDescription: consumedTwin.desc,
        matchedStoredCurrency: consumedTwin.currency,
        matchedStoredCashAccountId: consumedTwin.cashAccountId,
      })
      // Persist the hand-mirror adoption: bind the account-unbound hand row to
      // the account this feed batch settled on. Consumption is otherwise
      // in-memory only, so without this ONE null-account hand row could
      // consume one genuine feed row per sync call on EVERY account whose
      // bucket happens to be date+öre+currency symmetric: permanent silent
      // suppression across accounts. After the stamp, the account guard
      // excludes this row from any other account's mirror. The `.is()` filter
      // makes the write race-safe (never overwrites a concurrent binding),
      // and a failure is non-critical: dedup already happened, the stamp only
      // narrows future consumption.
      if (
        !consumedTwin.isImportFeed &&
        consumedTwin.id !== null &&
        consumedTwin.cashAccountId === null &&
        cashAccountId !== null
      ) {
        if (options?.bankRoute) {
          const route = options.bankRoute
          const { data: adoptedId, error: adoptionError } = await supabase.rpc('bind_bank_transaction', {
            p_company_id: companyId, p_connection_id: route.connectionId, p_account_uid: route.accountUid,
            p_currency: route.currency, p_route_token: route.token, p_transaction_id: consumedTwin.id,
            p_expected_date: raw.date, p_expected_amount: raw.amount,
          })
          if (adoptionError || !adoptedId) {
            throw new Error(`Bank transaction adoption failed: ${adoptionError?.message ?? 'missing acknowledgement'}`)
          }
          continue
        }
        try {
          const { error: stampError } = await supabase
            .from('transactions')
            .update({ cash_account_id: cashAccountId })
            .eq('id', consumedTwin.id)
            .is('cash_account_id', null)
          if (stampError) {
            log.warn('hand-mirror adoption stamp failed; row stays unbound', {
              transactionId: consumedTwin.id,
              cashAccountId,
              error: stampError.message,
            })
          }
        } catch (stampError) {
          log.warn('hand-mirror adoption stamp failed; row stays unbound', {
            transactionId: consumedTwin.id,
            cashAccountId,
            error: stampError instanceof Error ? stampError.message : String(stampError),
          })
        }
      }
      continue
    }

    // 2. Insert new transaction (with SEK conversion for foreign currencies)
    const rateInfo = raw.currency && raw.currency !== 'SEK'
      ? exchangeRatesByDate.get(`${raw.currency}|${raw.date}`)
      : undefined
    const amountSek = rateInfo ? sekOfForeign(raw.amount, rateInfo.rate) : null
    // A purchase made in another currency than the account's (the bank's
    // enrichment): the instructed amount and currency travel on any account;
    // the bank's rate only on a SEK account, where exchange_rate has no
    // Riksbanken meaning (every SEK resolver short-circuits on the currency).
    const instructedCurrency = raw.instructed_currency?.toUpperCase() || null
    const foreignPurchase = raw.instructed_amount != null && instructedCurrency !== null && instructedCurrency !== raw.currency?.toUpperCase()
    const bankRate = foreignPurchase && raw.currency?.toUpperCase() === 'SEK' ? raw.exchange_rate ?? null : null

    const insertPayload = {
        company_id: companyId,
        user_id: userId,
        bank_connection_id: raw.bank_connection_id || null,
        cash_account_id: await rowCashAccountId(raw),
        external_id: raw.external_id,
        date: raw.date,
        // Working title: the source description with the trailing channel
        // phrase stripped (classifyTransactionMethod). Falls back to the full
        // string when no phrase matched or stripping would empty it.
        description: displayTitle,
        // Immutable bank/PSD2 original: the FULL source string, captured once,
        // never overwritten by a title edit or the phrase strip. Dedup-bridge
        // source and the "restore original" value.
        original_description: description,
        transaction_method: transactionMethod,
        bank_transaction_code: raw.bank_transaction_code || null,
        proprietary_bank_transaction_code: raw.proprietary_bank_transaction_code || null,
        amount: raw.amount,
        currency: raw.currency,
        amount_sek: amountSek,
        exchange_rate: rateInfo?.rate ?? bankRate,
        exchange_rate_date: rateInfo?.date ?? null,
        category: 'uncategorized',
        is_business: null,
        mcc_code: raw.mcc_code || null,
        merchant_name: raw.merchant_name || null,
        reference: raw.reference || null,
        import_source: raw.import_source || null,
        // Batch link for "undo this import": only the bank-file import paths
        // pass this; PSD2 sync and MCP rows stay NULL.
        bank_file_import_id: options?.bankFileImportId ?? null,
        counterparty_iban: raw.counterparty_iban || null,
        counterparty_account: raw.counterparty_account || null,
        value_date: raw.value_date || null,
        end_to_end_id: raw.end_to_end_id || null,
        provider_transaction_id: raw.provider_transaction_id || null,
        raw_document_id: raw.raw_document_id || null,
        counterparty_org_number: raw.counterparty_org_number || null,
        billing_country: raw.billing_country || null,
        card_country: raw.card_country || null,
        instructed_amount: foreignPurchase ? raw.instructed_amount : null,
        instructed_currency: foreignPurchase ? instructedCurrency : null,
        balance_after: raw.balance_after ?? null,
        is_enriched: raw.is_enriched ?? null,
        // When the row arrives enriched it took its enriched version now; a
        // re-read that flips the flag later stamps it then (enrichmentPatch).
        enriched_at: raw.is_enriched === true ? new Date().toISOString() : null,
    }
    const route = options?.bankRoute
    const { data: newTransaction, error: insertError } = route
      ? await supabase.rpc('insert_bank_transaction', {
          p_company_id: companyId, p_user_id: userId, p_connection_id: route.connectionId,
          p_account_uid: route.accountUid, p_currency: route.currency, p_route_token: route.token,
          p_transaction: insertPayload,
        })
      : await supabase.from('transactions').insert(insertPayload).select().single()

    if (insertError || !newTransaction) {
      // Layer 1, settled by the unique index instead of the pre-fetch: another
      // writer of the same feed committed this external_id after the batch
      // read the stored ids. The row exists, exactly as a pre-fetch one moment
      // later would have found it, so it is a duplicate, not a failed batch
      // (which would also skip the caller's balance refresh). Traced: with the
      // shared sync lease, two writers of one feed should be rare.
      if (isExternalIdConflict(insertError)) {
        recordSkip(submittedExternalIds[index], 'external_id_match', raw.external_id, null)
        log.warn('import dedup: external_id stored concurrently, skipped as duplicate', {
          decision: 'external-id-conflict',
          mode: 'enforced',
          bucket: bucketKey,
          incomingExternalId: raw.external_id,
          incomingSource: raw.import_source ?? null,
          cashAccountId,
        })
        continue
      }
      result.errors++
      if (!result.first_error && insertError) {
        result.first_error = {
          message: insertError.message,
          code: insertError.code ?? null,
          details: insertError.details ?? null,
          hint: insertError.hint ?? null,
        }
      }
      continue
    }

    result.imported++
    result.transaction_ids.push(newTransaction.id)
    if (newTransaction.amount > 0) inboundIds.push(newTransaction.id)

    // The Bankgirot split, when the row carries one: stored beside the row
    // whatever follows, with its per-part suggestions for an open row.
    const completeSplit = await storePartsForRow(newTransaction as Transaction, raw)

    // rawInsertOnly: skip invoice matching, and auto-categorization
    if (options?.rawInsertOnly) continue
    // A complete split explains the row: its parts name the invoices, and a
    // single-invoice hint or an auto-categorised voucher would contradict it.
    if (completeSplit) continue

    // Reconciliation against existing GL lines is intentionally NOT run on
    // import: auto-linking made imported transactions appear "bokförda" to
    // the user without any explicit action. Reconciliation is now a manual
    // operation (BankReconciliationView / runReconciliation / manualLink).

    // 3. The suggestion passes: the ingest matchers in their order (the
    // customer invoice match, the payment order's debit, the supplier
    // invoice heuristics, the ROT/RUT payout and payout set;
    // lib/composition/ingest-matchers.ts). A row one of them explains skips
    // the mapping engine.
    if (await matchers.match({ tx: newTransaction as Transaction, raw, reread: false })) continue

    // 4. Evaluate mapping rules for auto-categorization
    // Production-disabled: auto-booking only runs in local dev (and tests).
    // Users must explicitly book each transaction on the deployed app.
    // Reconciliation (step 2.5) still links transactions to existing GL lines.
    const autoBookEnabled = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    if (autoBookEnabled && !options?.skipAutoCategorization) {
      try {
        const mappingResult = await evaluateMappingRules(
          supabase,
          companyId,
          newTransaction as Transaction,
          await resolveCompanyEntityType(supabase, companyId),
          options?.settlementAccount,
          undefined,
          loadChart,
        )

        if (mappingResult.confidence >= 0.8 && !mappingResult.requires_review) {
          const journalEntry = await createTransactionJournalEntry(
            supabase,
            companyId,
            userId,
            newTransaction as Transaction,
            mappingResult,
            undefined,
            // The business event (posting port pilot; read only while
            // POSTING_EVENTS is shadow or strict), with the basis the row is
            // stamped with below. No category: the row is booked without one.
            {
              businessEvent: {
                linkBasis: linkBasisColumns('system_derived', {
                  ...(mappingResult.rule?.id ? { rule_id: mappingResult.rule.id } : {}),
                  score: mappingResult.confidence,
                }),
              },
            },
          )

          if (journalEntry) {
            await supabase
              .from('transactions')
              .update({
                journal_entry_id: journalEntry.id,
                is_business: !mappingResult.default_private,
                // Booked on arrival by a confident mapping rule: nobody chose it.
                ...linkBasisColumns('system_derived', {
                  ...(mappingResult.rule?.id ? { rule_id: mappingResult.rule.id } : {}),
                  score: mappingResult.confidence,
                }),
              })
              .eq('id', newTransaction.id)

            // Upsert counterparty template (auto-learned, lower confidence)
            try {
              await upsertCounterpartyTemplate(
                supabase, companyId, newTransaction as Transaction,
                mappingResult, 'auto_learned'
              )
            } catch {
              // Non-critical
            }

            result.auto_categorized++
            tallyPass('mapping-rule', 'explained')
          }
        }
      } catch {
        // Non-critical: continue processing
        tallyPass('mapping-rule', 'failed')
      }
    }
  }

  // One line per batch that reached the passes (never a raw insert).
  if (!options?.rawInsertOnly && (result.imported > 0 || rereadPasses > 0 || Object.keys(passHits).length > 0)) {
    log.info('ingest suggestion passes', {
      rows: rawTransactions.length,
      imported: result.imported,
      rereads: rereadPasses,
      passes: passHits,
      // Only when the package gate skipped something (INGEST_PACKAGE_GATING).
      ...(gate.off.size > 0 ? { packagesOff: [...gate.off].sort() } : {}),
    })
  }

  // After the last row: the matchers' finish (the collections sweep of the
  // inbound rows, right after this request answers), for every batch.
  matchers.finish(inboundIds)

  return result
}
