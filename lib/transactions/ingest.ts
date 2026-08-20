import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { getBestInvoiceMatch } from '@/lib/invoices/invoice-matching'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { contentBucketKey, descriptionsBridge, normalizeImportedDescription, shiftIsoDate } from '@/lib/transactions/external-id'
import { classifyTransactionMethod } from '@/lib/transactions/transaction-method'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { createLogger } from '@/lib/logger'
import type { Transaction, RawTransaction, IngestResult, IngestOptions, SupplierInvoice, Currency, ExchangeRate } from '@/types'

// Re-export types for backward compatibility
export type { RawTransaction, IngestResult } from '@/types'

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
   * The stored row's `external_id`. Used ONLY by the shadow-mode same-feed
   * scope-drift instrumentation (see ingestTransactions): a stored row is a
   * "drift candidate" when its id is NOT among the incoming batch's ids, which
   * is what distinguishes an IBAN-scope re-import from a normal sibling whose id
   * Layer-1 already reconciles. Null for rows predating the column.
   */
  externalId: string | null
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
): void {
  const key = contentBucketKey(date, amount)
  const entry: BucketEntry = {
    id,
    desc: description.toLowerCase().trim(),
    cashAccountId,
    source,
    isImportFeed,
    currency,
    externalId,
  }
  const entries = bucket.get(key)
  if (entries) entries.push(entry)
  else bucket.set(key, [entry])
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
}

/**
 * Build the (date, öre)-bucketed maps of already-stored transactions in the
 * batch's date range: the stored-row universe every content-dedup layer works
 * against.
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
 */
export async function buildExistingTransactionMaps(
  supabase: SupabaseClient,
  companyId: string,
  rawTransactions: Array<{ date: string }>
): Promise<ExistingTransactionMaps> {
  const booked: DescBucket = new Map()
  const unbookedImported: DescBucket = new Map()
  if (rawTransactions.length === 0) return { booked, unbookedImported }

  const dates = rawTransactions.map((t) => t.date).sort()
  const dateFrom = dates[0]
  const dateTo = dates[dates.length - 1]

  try {
    const bookedRows = await fetchAllRows<StoredDedupRow>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('id, date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, currency, external_id')
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
      addToBucket(
        booked,
        tx.id ?? null,
        tx.date,
        tx.amount,
        normalizeImportedDescription(tx.original_description ?? tx.description),
        tx.cash_account_id ?? null,
        tx.import_source ?? null,
        isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
        tx.currency ?? null,
        tx.external_id ?? null,
      )
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
        .select('id, date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, currency, external_id')
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
      addToBucket(
        unbookedImported,
        tx.id ?? null,
        tx.date,
        tx.amount,
        normalizeImportedDescription(tx.original_description ?? tx.description),
        tx.cash_account_id ?? null,
        tx.import_source ?? null,
        isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
        tx.currency ?? null,
        tx.external_id ?? null,
      )
    }
  } catch {
    // Non-critical: reconnect dedup will be skipped
  }

  return { booked, unbookedImported }
}

/**
 * Generic transaction ingestion pipeline.
 *
 * Handles:
 * 1. Deduplication via external_id
 * 1b. Content-based dedup (date+amount+description prefix) against already-booked
 *     transactions: catches cross-source duplicates, e.g. PSD2 row gets booked
 *     before the user later re-imports the same period via CSV.
 * 1c. Content-based dedup against unbooked enable_banking rows: catches PSD2
 *     reconnect duplicates AND CSV imports overlapping an active PSD2 sync (the
 *     description-prefix component makes this safe to apply across sources).
 * 2. Insert into transactions table
 * 3. OCR/reference-based invoice matching (highest confidence)
 * 4. Amount+customer fallback invoice matching
 * 5. Mapping rule evaluation for auto-categorization
 * 6. Auto-journal-entry creation for high-confidence matches
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
  const result: IngestResult = {
    imported: 0,
    duplicates: 0,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: [],
    shadow_scope_drift_candidates: 0,
    shadow_date_drift_candidates: 0,
  }

  const log = createLogger('transactions.ingest', { companyId })
  // SHADOW-ONLY instrumentation for the same-feed scope-drift bridge (Hole A:
  // Enable Banking returns the same account under a drifted IBAN, the
  // IBAN-embedded external_id changes, Layer-1 dedup misses the re-import, and
  // because both rows are the SAME feed the cross-channel mirror does not fire).
  // When on, we LOG which rows an enforcing rule WOULD treat as re-imports and
  // count them, but never change what gets inserted. Default on; set
  // DEDUP_SCOPE_DRIFT_MODE=off to silence. There is deliberately NO 'enforce'
  // branch yet: we validate on real fleet data first (see the plan).
  const scopeDriftShadow = process.env.DEDUP_SCOPE_DRIFT_MODE !== 'off'
  // SHADOW-ONLY instrumentation for the date-drift bridge: the content bridge
  // buckets on EXACT (date, öre), so a booking date that drifts a day between
  // syncs lands its twin in an ADJACENT bucket and every dedup layer misses it
  // (this produced the observed EB↔EB and CSV↔EB 1-day-apart duplicates). When
  // on, we LOG + COUNT which surviving rows a ±1-day-tolerant rule WOULD treat
  // as re-imports, but never change what is inserted. Default on; set
  // DEDUP_DATE_DRIFT_MODE=off to silence. No 'enforce' branch, same as
  // scope-drift, we validate on real fleet data first.
  const dateDriftShadow = process.env.DEDUP_DATE_DRIFT_MODE !== 'off'

  // Pre-fetch existing transactions for content-based dedup (date+amount+
  // description prefix, plus the cross-channel mirror below). Booked rows catch
  // cross-source duplicates after they've been booked; unbooked import-feed rows
  // catch the common case where a PSD2 row is still unbooked when the user
  // re-imports the same period via CSV, or the reverse, a CSV import that
  // predates the first PSD2 sync of the same account.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, rawTransactions)

  // Every row in one ingest call shares an import_source (EB sync passes
  // 'enable_banking', bank-file import passes 'csv_<format>'/'camt053'), so the
  // first row's source identifies this batch's channel. We use it to find
  // "cross-channel mirror" buckets: a (date, öre) bucket where the number of
  // incoming rows EQUALS the number of stored rows from a DIFFERENT feed. That
  // equality is the signal that the same set of real transactions is arriving
  // once per channel (e.g. Nordea's CSV export and its PSD2 feed), where the
  // per-row description is known-unreliable: CSV shows the payee, PSD2 the
  // OCR/message, or vice versa. Only in those buckets do we dedup on
  // (date, öre, account) without a description match (see consumeBridgingTwin).
  // An asymmetric bucket keeps the description requirement, so a genuinely-new
  // row is never collapsed into a different one.
  //
  // The same count-symmetry signal also runs against BOOKED hand-entered rows
  // (import_source manual/mcp/null): a user who bookkeeps by chat/MCP first and
  // connects the bank afterwards has already put the movement in the ledger,
  // and the feed's copy of it must not re-appear as a duplicate. This mirror is
  // gated harder than feed-vs-feed: the stored row must be BOOKED (staged/
  // unbooked hand-entered rows never consume an import), its currency must not
  // contradict the incoming row's, its cash account must be compatible, and the
  // bucket counts must match exactly. Tracked in a SEPARATE count map (built
  // further down, once the batch settlement account and the stored external_id
  // set are known) so the feed-vs-feed mirror semantics are untouched: a
  // hand-entered twin never breaks feed count symmetry.
  const batchSource = rawTransactions[0]?.import_source ?? null
  const batchIsImportFeed = isImportedTransaction({ import_source: batchSource })
  const incomingByBucket = new Map<string, number>()
  const crossSourceStoredByBucket = new Map<string, number>()
  const incomingCurrencyByBucket = new Map<string, string | null | typeof MIXED_CURRENCIES>()
  if (batchIsImportFeed) {
    for (const raw of rawTransactions) {
      const k = contentBucketKey(raw.date, raw.amount)
      incomingByBucket.set(k, (incomingByBucket.get(k) ?? 0) + 1)
      const cur = raw.currency ?? null
      if (!incomingCurrencyByBucket.has(k)) incomingCurrencyByBucket.set(k, cur)
      else if (incomingCurrencyByBucket.get(k) !== cur) incomingCurrencyByBucket.set(k, MIXED_CURRENCIES)
    }
    for (const bucket of [existingMaps.booked, existingMaps.unbookedImported]) {
      for (const [k, entries] of bucket) {
        for (const entry of entries) {
          if (entry.isImportFeed && entry.source !== batchSource) {
            crossSourceStoredByBucket.set(k, (crossSourceStoredByBucket.get(k) ?? 0) + 1)
          }
        }
      }
    }
  }

  // When rawInsertOnly is set (viewer imports), skip pre-fetching supplier
  // invoices and exchange rates: they are not used.
  let unpaidSupplierInvoices: SupplierInvoice[] = []
  // Keyed by `${currency}|${date}` so each non-SEK transaction gets the
  // rate that was valid on its own transaction date, not the import date.
  const exchangeRatesByDate = new Map<string, ExchangeRate>()

  if (!options?.rawInsertOnly) {
  // Pre-fetch unpaid supplier invoices for expense matching (non-critical)
  try {
    unpaidSupplierInvoices = await fetchAllRows<SupplierInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('*, supplier:suppliers(*)')
        .eq('company_id', companyId)
        .in('status', ['registered', 'approved'])
        .gt('remaining_amount', 0)
        .range(from, to)
    )
  } catch {
    // Non-critical: supplier invoice matching will be skipped
  }
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
  const existingExternalIds = new Set<string>()
  const externalIds = rawTransactions.map(t => t.external_id)
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500)
    const { data } = await supabase
      .from('transactions')
      .select('external_id')
      .eq('company_id', companyId)
      .in('external_id', chunk)
    data?.forEach(r => existingExternalIds.add(r.external_id))
  }

  // Resolve the cash account this batch settled on, once. Every row in one
  // ingest call shares a settlement account: enable-banking calls this per
  // account (settlementAccount = account.ledger_account), CSV import passes the
  // single account the user picked. cash_accounts.ledger_account is unique per
  // company, so this is a single-row lookup. Tolerate a miss: the row stays
  // unbound (cash_account_id NULL) and reconciliation falls back to currency.
  // We never auto-create a cash account here; that would race upsertFromPsd2's
  // seed-promotion logic in lib/cash-accounts/service.ts.
  let cashAccountId: string | null = null
  if (options?.settlementAccount) {
    const { data: ca } = await supabase
      .from('cash_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('ledger_account', options.settlementAccount)
      .maybeSingle()
    cashAccountId = (ca?.id as string | undefined) ?? null
  }

  // ── Shadow-mode same-feed scope-drift precompute (measure only) ──────────
  // Two per-(date, öre) bucket counts that, when EQUAL and non-zero, mark a
  // bucket as a probable scope-drift mirror:
  //   - unmatchedIncomingByBucket: incoming rows whose external_id is NOT
  //     already stored (i.e. Layer-1 will not reconcile them, the ones that
  //     would otherwise insert as fresh rows).
  //   - driftCandidateStoredByBucket: stored rows from THIS SAME feed whose id
  //     the incoming batch does NOT carry (so they are "orphaned" by a drifted
  //     id), restricted to account-compatible rows. Account compatibility uses
  //     the batch settlement account (cash_account_id), which is keyed on the
  //     provider's STABLE account uid, not the drifting IBAN that broke the
  //     external_id (see lib/cash-accounts/service.ts upsertFromPsd2). So a
  //     genuinely different account on the same company is never a candidate.
  // Equality is the safety signal (same as the cross-channel mirror): it means
  // the same set of transactions re-arrived once, under new ids. An asymmetric
  // bucket is left alone. Counts are pre-loop snapshots; the gate is evaluated
  // per incoming row inside the loop.
  const incomingIdSet = new Set(externalIds)
  // Incoming rows Layer-1 will NOT reconcile (their external_id is not already
  // stored): the honest per-bucket count of rows that will actually reach the
  // content-dedup layer. Shared by the hand-entered mirror (enforcing) and the
  // scope-drift shadow (measure-only): the coarse incomingByBucket would let a
  // Layer-1 duplicate inflate the symmetry check.
  const unmatchedIncomingByBucket = new Map<string, number>()
  if (batchIsImportFeed) {
    for (const raw of rawTransactions) {
      if (!existingExternalIds.has(raw.external_id)) {
        const k = contentBucketKey(raw.date, raw.amount)
        unmatchedIncomingByBucket.set(k, (unmatchedIncomingByBucket.get(k) ?? 0) + 1)
      }
    }
  }

  // ── Booked-hand-entered mirror candidates ────────────────────────────────
  // Built HERE, after the batch settlement account (cashAccountId) and the
  // stored external_id set are known, so the counts apply the SAME guards the
  // consume step applies (account compatibility + currency). Counting entries
  // the consume step would reject makes "symmetry" lie: an unconsumable twin
  // could switch the mirror on and collapse a genuinely-new row. Hand-entered
  // candidates exist ONLY in the booked map: the unbooked map's query excludes
  // manual/mcp/null sources at the DB level.
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
        const accountCompatible =
          cashAccountId === null || entry.cashAccountId === null || entry.cashAccountId === cashAccountId
        if (!accountCompatible) continue
        if (entry.currency !== null && bucketCurrency !== null && entry.currency !== bucketCurrency) continue
        bookedHandEnteredByBucket.set(k, (bookedHandEnteredByBucket.get(k) ?? 0) + 1)
      }
    }
  }

  const driftCandidateStoredByBucket = new Map<string, number>()
  if (batchIsImportFeed && scopeDriftShadow) {
    for (const bucket of [existingMaps.booked, existingMaps.unbookedImported]) {
      for (const [k, entries] of bucket) {
        for (const entry of entries) {
          const sameFeed = entry.isImportFeed && entry.source === batchSource
          const accountCompatible =
            cashAccountId === null ||
            entry.cashAccountId === null ||
            entry.cashAccountId === cashAccountId
          const idOrphaned = entry.externalId !== null && !incomingIdSet.has(entry.externalId)
          if (sameFeed && accountCompatible && idOrphaned) {
            driftCandidateStoredByBucket.set(k, (driftCandidateStoredByBucket.get(k) ?? 0) + 1)
          }
        }
      }
    }
  }

  // ── Shadow-mode date-drift precompute (measure only) ─────────────────────
  // The content bridge matches only the EXACT (date, öre) bucket, so a twin
  // whose booking date drifted a day is invisible to it. Snapshot the stored
  // buckets BEFORE the dedup loop (a COPY of each bucket's entries, so Layer-2's
  // splices don't mutate what the shadow reads), so each surviving row can look
  // one day to either side for an account-compatible twin without disturbing
  // real dedup. Window is ±1 day (the only gap observed); a named constant so
  // widening to ±2 is one line if fleet data shows it.
  const DATE_DRIFT_WINDOW_DAYS = 1
  const storedByBucketForDrift = new Map<string, BucketEntry[]>()
  if (batchIsImportFeed && dateDriftShadow) {
    for (const bucket of [existingMaps.booked, existingMaps.unbookedImported]) {
      for (const [k, entries] of bucket) {
        const snapshot = storedByBucketForDrift.get(k)
        if (snapshot) snapshot.push(...entries)
        else storedByBucketForDrift.set(k, [...entries])
      }
    }
  }

  // Track already-matched invoice IDs within this ingestion batch
  // to prevent suggesting the same invoice for multiple transactions
  const matchedInvoiceIds = new Set<string>()
  const matchedSupplierInvoiceIds = new Set<string>()

  for (const raw of rawTransactions) {
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

    // 1. Check for duplicates via external_id (batch pre-fetched)
    if (existingExternalIds.has(raw.external_id)) {
      result.duplicates++
      continue
    }

    // 1b/1c. Content-dedup bridge: skip if an existing booked row (any source)
    // OR an unbooked import-feed row shares this (date, öre) bucket and EITHER
    // (a) a *bridging* description (prefix-containment, see descriptionsBridge),
    // OR (b) the bucket is a cross-channel mirror (crossSourceMirror below),
    // OR (c) the bucket is a booked-hand-entered mirror (handEnteredMirror).
    // (a) catches re-imports the external_id check misses: old-format ids
    // re-synced after the id scheme changed, and PSD2 description enrichment
    // between syncs ("TIC" → "TIC  BG … via internet"). (b) catches the same
    // bank account imported via two channels whose descriptions don't bridge at
    // all (Nordea CSV payee "TELENOR"/"Nordea" vs PSD2 OCR/message), which (a)
    // alone cannot. (c) catches the feed delivering a movement the user already
    // booked by hand (MCP/manual) under a free-form title that shares no text
    // with the bank's ("Egen insättning …" vs "TRANSFER-123 Topped up").
    // Booked first, then unbooked.
    //
    // Consumed with COUNTING semantics: each match splices one stored entry out
    // of its bucket, so N stored twins dedup exactly N incoming and two
    // genuinely-distinct same-(date,amount) transactions are kept apart. The
    // text bridge is tried first (LONGEST bridging description wins, so a
    // more-specific twin is matched before a generic one); the cross-channel
    // mirror is the text-independent fallback.
    //
    // Account guard: when BOTH the incoming batch and a stored entry have a known
    // cash_account_id, they must match, so a transaction on one bank account
    // never deduplicates a genuinely-different one on another account of the same
    // company (the content bucket is company-wide; only external_id embeds the
    // account). A null on either side falls back to bridge-allowed, leaving
    // single-account and legacy (un-backfilled) rows exactly as before. The guard
    // applies to BOTH the text and the cross-channel-mirror path.
    //
    // Currency guard: same shape, same null-tolerance, applied to all three
    // match paths. The bucket key carries no currency, so 250,00 EUR and
    // 250,00 SEK on one date share a bucket; without this an incoming row in
    // one currency consumes a stored row in another and the survivor is never
    // bokförd. A null on either side stays compatible (legacy rows).
    //
    // crossSourceMirror: this (date, öre) bucket holds the same number of
    // incoming rows as stored rows from a different feed → the same real
    // transactions arriving once per channel. Only then is the description
    // requirement dropped; an asymmetric bucket keeps it, so when the channels
    // disagree on how many transactions a bucket holds we keep a visible
    // (deletable) duplicate rather than risk collapsing a genuinely-new row.
    //
    // handEnteredMirror: the analogous signal against BOOKED hand-entered rows
    // (manual/mcp/null source). A booked hand-entered row means the user
    // already put this movement in the ledger before the feed delivered the
    // bank's copy (bookkeep-by-chat first, connect the bank later). Symmetry
    // compares the bucket's Layer-1-UNMATCHED incoming count (a row Layer-1
    // reconciles never reaches this layer, so it must not inflate the count)
    // against the guarded hand-entered candidate count, plus a per-entry
    // currency gate in consumeBridgingTwin (the bucket key is only date+öre,
    // and hand-entered rows often lack a cash_account_id for the account guard
    // to bite on).
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
        const sameAccount =
          cashAccountId === null || entry.cashAccountId === null || entry.cashAccountId === cashAccountId
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
        if (descriptionsBridge(description, entry.desc) && entry.desc.length > bestLen) {
          bestIdx = i
          bestLen = entry.desc.length
        }
        // Text-independent fallback: in a cross-channel mirror bucket a stored
        // entry from a different feed is the same transaction even when the
        // descriptions don't bridge. Remember the first eligible one.
        if (crossIdx === -1 && crossSourceMirror && entry.isImportFeed && entry.source !== batchSource) {
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
    const consumedTwin =
      consumeBridgingTwin(existingMaps.booked) ?? consumeBridgingTwin(existingMaps.unbookedImported)
    if (consumedTwin) {
      result.duplicates++
      // Leave a trace of the drop. Layer-1 (external_id) duplicates are exact
      // key collisions and need none, but this layer drops a row on a
      // judgement call (text bridge / cross-channel mirror / hand mirror), and
      // an incoming row dropped here is never inserted and therefore never
      // bokförd. result.duplicates does count it, and that count reaches the
      // API response plus bank_file_imports.duplicate_count, but no import UI
      // currently RENDERS it (BankFileResultStep and the EB sync toast show
      // `imported` only), and the count cannot distinguish this judgement call
      // from an exact Layer-1 id collision anyway. So this log is the only
      // per-row record of WHICH affärshändelse was dropped and against what;
      // keep it until a UI surfaces skipped rows. Same field shape as the two
      // shadow blocks below.
      log.info('import dedup: content-bridge duplicate skipped', {
        decision: 'content-bridge',
        mode: 'enforced',
        bucket: bucketKey,
        incomingExternalId: raw.external_id,
        incomingDescription: description,
        incomingAmount: raw.amount,
        incomingCurrency: rawCurrency,
        incomingSource: raw.import_source ?? null,
        cashAccountId,
        matchedStoredId: consumedTwin.id,
        matchedStoredExternalId: consumedTwin.externalId,
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

    // SHADOW-ONLY: this row survived Layer-1 and Layer-2, so today it WILL
    // insert. If its bucket is a symmetric same-feed scope-drift mirror (equal
    // non-zero counts of unreconciled incoming rows and account-compatible
    // same-feed drift candidates), an enforcing rule WOULD treat it as a
    // re-import. We only record it (full content on both sides so every
    // decision can be human-verified against real fleet data before any
    // enforcement is switched on), then fall through and insert exactly as
    // before. This block has NO effect on result.imported/duplicates.
    if (scopeDriftShadow && batchIsImportFeed) {
      const driftCount = driftCandidateStoredByBucket.get(bucketKey) ?? 0
      const unmatchedCount = unmatchedIncomingByBucket.get(bucketKey) ?? 0
      if (driftCount > 0 && unmatchedCount === driftCount) {
        let matched: BucketEntry | undefined
        for (const bucket of [existingMaps.booked, existingMaps.unbookedImported]) {
          const entries = bucket.get(bucketKey)
          if (!entries) continue
          matched = entries.find(
            (e) =>
              e.isImportFeed &&
              e.source === batchSource &&
              e.externalId !== null &&
              !incomingIdSet.has(e.externalId) &&
              (cashAccountId === null ||
                e.cashAccountId === null ||
                e.cashAccountId === cashAccountId)
          )
          if (matched) break
        }
        if (matched) {
          result.shadow_scope_drift_candidates =
            (result.shadow_scope_drift_candidates ?? 0) + 1
          log.info('import dedup shadow: same-feed scope-drift candidate', {
            decision: 'same-feed-scope-drift',
            mode: 'shadow',
            bucket: bucketKey,
            unmatchedIncoming: unmatchedCount,
            driftCandidates: driftCount,
            incomingExternalId: raw.external_id,
            incomingDescription: description,
            incomingAmount: raw.amount,
            incomingSource: raw.import_source ?? null,
            cashAccountId,
            matchedStoredExternalId: matched.externalId,
            matchedStoredDescription: matched.desc,
            matchedStoredCashAccountId: matched.cashAccountId,
          })
        }
      }
    }

    // SHADOW-ONLY: date-drift. This row survived Layer-1 + Layer-2 and WILL
    // insert. The content bridge only matched its EXACT (date, öre) bucket, so a
    // twin whose booking date drifted a day is invisible to it. Look ±1 day for
    // an account-compatible stored twin that EITHER bridges by description
    // (same/enriched title, the EB↔EB hotel/fee case) OR is a cross-feed
    // count-symmetric mirror displaced by a day (the CSV↔EB case where the
    // descriptions don't bridge). Record it for fleet validation, then insert
    // unchanged: this block never affects result.imported/duplicates.
    //
    // Fail-safe date guard: measurement must NEVER abort a real import. raw.date
    // is always ISO in practice, but a malformed value would make shiftIsoDate
    // throw (new Date(NaN).toISOString()), so we skip detection rather than risk
    // it. Any /^\d{4}-\d{2}-\d{2}$/ value is safe: Date.UTC normalizes
    // out-of-range parts to a finite epoch, never NaN.
    if (dateDriftShadow && batchIsImportFeed && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
      let driftMatch: { entry: BucketEntry; gap: number; signal: 'desc' | 'cross-channel' } | undefined
      const incomingHere = incomingByBucket.get(bucketKey) ?? 0
      for (let delta = 1; delta <= DATE_DRIFT_WINDOW_DAYS && !driftMatch; delta++) {
        for (const sign of [-1, 1] as const) {
          const adjKey = contentBucketKey(shiftIsoDate(raw.date, sign * delta), raw.amount)
          const entries = storedByBucketForDrift.get(adjKey)
          if (!entries) continue
          // Cross-feed count-symmetry across the drift: equal counts of incoming
          // rows in THIS bucket and account-compatible cross-feed rows one day
          // over, the cross-channel mirror, displaced by a date drift.
          const adjCrossFeed = entries.filter(
            (e) =>
              e.isImportFeed &&
              e.source !== batchSource &&
              (cashAccountId === null || e.cashAccountId === null || e.cashAccountId === cashAccountId),
          ).length
          const mirrorSymmetric = adjCrossFeed > 0 && incomingHere === adjCrossFeed
          for (const entry of entries) {
            const sameAccount =
              cashAccountId === null || entry.cashAccountId === null || entry.cashAccountId === cashAccountId
            if (!sameAccount) continue
            if (descriptionsBridge(description, entry.desc)) {
              driftMatch = { entry, gap: sign * delta, signal: 'desc' }
              break
            }
            if (mirrorSymmetric && entry.isImportFeed && entry.source !== batchSource) {
              driftMatch = { entry, gap: sign * delta, signal: 'cross-channel' }
              break
            }
          }
          if (driftMatch) break
        }
      }
      if (driftMatch) {
        result.shadow_date_drift_candidates = (result.shadow_date_drift_candidates ?? 0) + 1
        log.info('import dedup shadow: date-drift candidate', {
          decision: 'date-drift',
          mode: 'shadow',
          signal: driftMatch.signal,
          dayGap: driftMatch.gap,
          bucket: bucketKey,
          incomingExternalId: raw.external_id,
          incomingDescription: description,
          incomingAmount: raw.amount,
          incomingSource: raw.import_source ?? null,
          cashAccountId,
          matchedStoredExternalId: driftMatch.entry.externalId,
          matchedStoredDescription: driftMatch.entry.desc,
          matchedStoredCashAccountId: driftMatch.entry.cashAccountId,
        })
      }
    }

    // 2. Insert new transaction (with SEK conversion for foreign currencies)
    const rateInfo = raw.currency && raw.currency !== 'SEK'
      ? exchangeRatesByDate.get(`${raw.currency}|${raw.date}`)
      : undefined
    const amountSek = rateInfo
      ? Math.round(raw.amount * rateInfo.rate * 100) / 100
      : null

    const { data: newTransaction, error: insertError } = await supabase
      .from('transactions')
      .insert({
        company_id: companyId,
        user_id: userId,
        bank_connection_id: raw.bank_connection_id || null,
        cash_account_id: cashAccountId,
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
        exchange_rate: rateInfo?.rate ?? null,
        exchange_rate_date: rateInfo?.date ?? null,
        category: 'uncategorized',
        is_business: null,
        mcc_code: raw.mcc_code || null,
        merchant_name: raw.merchant_name || null,
        reference: raw.reference || null,
        import_source: raw.import_source || null,
        counterparty_iban: raw.counterparty_iban || null,
        counterparty_account: raw.counterparty_account || null,
        // Batch provenance: which bank_file_imports row inserted this
        // transaction. Drives the bulk "undo this import" path (#1672).
        bank_file_import_id: options?.bankFileImportId ?? null,
      })
      .select()
      .single()

    if (insertError || !newTransaction) {
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

    // rawInsertOnly: skip invoice matching, and auto-categorization
    if (options?.rawInsertOnly) continue

    // Reconciliation against existing GL lines is intentionally NOT run on
    // import: auto-linking made imported transactions appear "bokförda" to
    // the user without any explicit action. Reconciliation is now a manual
    // operation (BankReconciliationView / runReconciliation / manualLink).

    // 3. For income transactions, try invoice matching
    if (newTransaction.amount > 0) {
      try {
        // OCR/reference matching is handled inside getBestInvoiceMatch
        // (which calls findMatchingInvoices, which now checks references)
        const bestMatch = await getBestInvoiceMatch(
          supabase,
          companyId,
          newTransaction as Transaction,
          0.50
        )

        if (bestMatch && !matchedInvoiceIds.has(bestMatch.invoice.id)) {
          await supabase
            .from('transactions')
            .update({ potential_invoice_id: bestMatch.invoice.id })
            .eq('id', newTransaction.id)

          logMatchEvent(supabase, userId, newTransaction.id, 'auto_suggested', {
            invoiceId: bestMatch.invoice.id,
            matchConfidence: bestMatch.confidence,
            matchMethod: bestMatch.matchReason,
          })

          matchedInvoiceIds.add(bestMatch.invoice.id)
          result.auto_matched_invoices++
          // Skip mapping engine: transaction has an invoice match.
          // Auto-categorization would create an orphaned journal entry
          // that conflicts with the eventual invoice payment entry.
          continue
        }
      } catch {
        // Non-critical: continue processing
      }
    }

    // 3b. For expense transactions, try supplier invoice matching
    if (newTransaction.amount < 0 && unpaidSupplierInvoices.length > 0) {
      try {
        const match = findSupplierInvoiceMatch(
          newTransaction as Transaction,
          unpaidSupplierInvoices
        )

        if (match && !matchedSupplierInvoiceIds.has(match.supplierInvoice.id)) {
          // ALWAYS a suggestion (potential_supplier_invoice_id), never a hard
          // link. supplier_invoice_id is reserved for completed matches: the
          // match route books the payment voucher when it sets it. A sync-time
          // hard link booked nothing, left the invoice open, and then BLOCKED
          // the match route (MATCH_SI_TX_ALREADY_LINKED), stranding the
          // transaction with no path to a payment voucher.
          await supabase
            .from('transactions')
            .update({ potential_supplier_invoice_id: match.supplierInvoice.id })
            .eq('id', newTransaction.id)

          logMatchEvent(supabase, userId, newTransaction.id, 'auto_suggested', {
            supplierInvoiceId: match.supplierInvoice.id,
            matchConfidence: match.confidence,
            matchMethod: match.matchMethod,
          })

          if (match.confidence >= 0.85 && !match.ambiguous) {
            // High-confidence unambiguous hit: drain the pool so the next
            // transaction can't claim the same invoice, and skip the mapping
            // engine: auto-categorization would create an orphaned journal
            // entry that conflicts with the eventual payment booking.
            unpaidSupplierInvoices = unpaidSupplierInvoices.filter(
              inv => inv.id !== match.supplierInvoice.id
            )
            matchedSupplierInvoiceIds.add(match.supplierInvoice.id)

            result.auto_matched_invoices++
            continue
          }
          // Lower confidence (0.70-0.85) or ambiguous: tentative, do NOT
          // drain the pool.
        }
      } catch {
        // Non-critical: continue processing
      }
    }

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
          undefined,
          options?.settlementAccount
        )

        if (mappingResult.confidence >= 0.8 && !mappingResult.requires_review) {
          const journalEntry = await createTransactionJournalEntry(
            supabase,
            companyId,
            userId,
            newTransaction as Transaction,
            mappingResult
          )

          if (journalEntry) {
            await supabase
              .from('transactions')
              .update({
                journal_entry_id: journalEntry.id,
                is_business: !mappingResult.default_private,
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
          }
        }
      } catch {
        // Non-critical: continue processing
      }
    }
  }

  return result
}
