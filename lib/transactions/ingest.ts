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
import { isImportedTransaction } from '@/lib/transactions/origin'
import { createLogger } from '@/lib/logger'
import type { Transaction, RawTransaction, IngestResult, IngestOptions, SupplierInvoice, Currency, ExchangeRate } from '@/types'

// Re-export types for backward compatibility
export type { RawTransaction, IngestResult } from '@/types'

/**
 * One existing row in a content-dedup bucket: its normalized/lowercased
 * description, the cash account it settled on (null for legacy rows that
 * predate the cash_account_id backfill), the import channel it came from, and
 * whether that channel is an external feed (vs a hand-entered row). `source` +
 * `isImportFeed` drive the cross-channel mirror bridge (see
 * `consumeBridgingTwin`); `cashAccountId` is the cross-account guard.
 */
type BucketEntry = {
  desc: string
  cashAccountId: string | null
  source: string | null
  isImportFeed: boolean
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
type DescBucket = Map<string, BucketEntry[]>

interface ExistingTransactionMaps {
  /** Booked transactions (any source): consumed by any incoming raw transaction. */
  booked: DescBucket
  /**
   * Unbooked rows from ANY external import feed (Enable Banking PSD2 sync,
   * bank-file CSV/CAMT import): consumed by any incoming raw transaction
   * regardless of source. Catches the cross-channel re-import: the same bank
   * account pulled once via PSD2 and once via a CSV/CAMT file upload (in either
   * order), plus PSD2 reconnect duplicates whose external_id regenerated.
   * Hand-entered rows (import_source manual/mcp/null) are deliberately
   * excluded: only real feeds mirror one another, and a manual row must never
   * be silently consumed by an import.
   */
  unbookedImported: DescBucket
}

/** Push a row into its (date, öre) bucket, normalizing the description. */
function addToBucket(
  bucket: DescBucket,
  date: string,
  amount: number | string,
  description: string,
  cashAccountId: string | null,
  source: string | null,
  isImportFeed: boolean,
  externalId: string | null,
): void {
  const key = contentBucketKey(date, amount)
  const entry: BucketEntry = {
    desc: description.toLowerCase().trim(),
    cashAccountId,
    source,
    isImportFeed,
    externalId,
  }
  const entries = bucket.get(key)
  if (entries) entries.push(entry)
  else bucket.set(key, [entry])
}

async function buildExistingTransactionMaps(
  supabase: SupabaseClient,
  companyId: string,
  rawTransactions: RawTransaction[]
): Promise<ExistingTransactionMaps> {
  const booked: DescBucket = new Map()
  const unbookedImported: DescBucket = new Map()
  if (rawTransactions.length === 0) return { booked, unbookedImported }

  const dates = rawTransactions.map((t) => t.date).sort()
  const dateFrom = dates[0]
  const dateTo = dates[dates.length - 1]

  try {
    const { data: bookedRows } = await supabase
      .from('transactions')
      .select('date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, external_id')
      .eq('company_id', companyId)
      .not('journal_entry_id', 'is', null)
      .gte('date', dateFrom)
      .lte('date', dateTo)

    if (bookedRows) {
      for (const tx of bookedRows) {
        // Key off the immutable bank original, not the user-editable
        // description: a title edit must never make the dedup bridge miss a
        // genuine re-import. Falls back to description for rows predating the
        // original_description column.
        addToBucket(
          booked,
          tx.date,
          tx.amount,
          normalizeImportedDescription(tx.original_description ?? tx.description),
          tx.cash_account_id ?? null,
          tx.import_source ?? null,
          isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
          tx.external_id ?? null,
        )
      }
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
    const { data: unbookedRows } = await supabase
      .from('transactions')
      .select('date, amount, original_description, description, cash_account_id, import_source, bank_connection_id, external_id')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .not('import_source', 'is', null)
      .neq('import_source', 'manual')
      .neq('import_source', 'mcp')
      .gte('date', dateFrom)
      .lte('date', dateTo)

    if (unbookedRows) {
      for (const tx of unbookedRows) {
        // See booked-map note: dedup on the immutable bank original so a
        // user title edit cannot reopen the duplicate-import window.
        addToBucket(
          unbookedImported,
          tx.date,
          tx.amount,
          normalizeImportedDescription(tx.original_description ?? tx.description),
          tx.cash_account_id ?? null,
          tx.import_source ?? null,
          isImportedTransaction({ import_source: tx.import_source, bank_connection_id: tx.bank_connection_id }),
          tx.external_id ?? null,
        )
      }
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
  const batchSource = rawTransactions[0]?.import_source ?? null
  const batchIsImportFeed = isImportedTransaction({ import_source: batchSource })
  const incomingByBucket = new Map<string, number>()
  const crossSourceStoredByBucket = new Map<string, number>()
  if (batchIsImportFeed) {
    for (const raw of rawTransactions) {
      const k = contentBucketKey(raw.date, raw.amount)
      incomingByBucket.set(k, (incomingByBucket.get(k) ?? 0) + 1)
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
  const unmatchedIncomingByBucket = new Map<string, number>()
  const driftCandidateStoredByBucket = new Map<string, number>()
  if (batchIsImportFeed && scopeDriftShadow) {
    for (const raw of rawTransactions) {
      if (!existingExternalIds.has(raw.external_id)) {
        const k = contentBucketKey(raw.date, raw.amount)
        unmatchedIncomingByBucket.set(k, (unmatchedIncomingByBucket.get(k) ?? 0) + 1)
      }
    }
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
    // the legacy English 'Unknown' sentinel. This normalized value is stored as
    // both description and original_description below; it's what the user sees
    // and edits, and what the content-dedup key is built from.
    const description = normalizeImportedDescription(raw.description)

    // 1. Check for duplicates via external_id (batch pre-fetched)
    if (existingExternalIds.has(raw.external_id)) {
      result.duplicates++
      continue
    }

    // 1b/1c. Content-dedup bridge: skip if an existing booked row (any source)
    // OR an unbooked import-feed row shares this (date, öre) bucket and EITHER
    // (a) a *bridging* description (prefix-containment, see descriptionsBridge),
    // OR (b) the bucket is a cross-channel mirror (crossSourceMirror below).
    // (a) catches re-imports the external_id check misses: old-format ids
    // re-synced after the id scheme changed, and PSD2 description enrichment
    // between syncs ("TIC" → "TIC  BG … via internet"). (b) catches the same
    // bank account imported via two channels whose descriptions don't bridge at
    // all (Nordea CSV payee "TELENOR"/"Nordea" vs PSD2 OCR/message), which (a)
    // alone cannot. Booked first, then unbooked.
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
    // crossSourceMirror: this (date, öre) bucket holds the same number of
    // incoming rows as stored rows from a different feed → the same real
    // transactions arriving once per channel. Only then is the description
    // requirement dropped; an asymmetric bucket keeps it, so when the channels
    // disagree on how many transactions a bucket holds we keep a visible
    // (deletable) duplicate rather than risk collapsing a genuinely-new row.
    const bucketKey = contentBucketKey(raw.date, raw.amount)
    const crossSourceMirror =
      batchIsImportFeed &&
      (crossSourceStoredByBucket.get(bucketKey) ?? 0) > 0 &&
      incomingByBucket.get(bucketKey) === crossSourceStoredByBucket.get(bucketKey)
    const consumeBridgingTwin = (bucket: DescBucket): boolean => {
      const entries = bucket.get(bucketKey)
      if (!entries || entries.length === 0) return false
      let bestIdx = -1
      let bestLen = -1
      let crossIdx = -1
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const sameAccount =
          cashAccountId === null || entry.cashAccountId === null || entry.cashAccountId === cashAccountId
        if (!sameAccount) continue
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
      }
      const idx = bestIdx !== -1 ? bestIdx : crossIdx
      if (idx === -1) return false
      entries.splice(idx, 1)
      return true
    }
    if (
      consumeBridgingTwin(existingMaps.booked) ||
      consumeBridgingTwin(existingMaps.unbookedImported)
    ) {
      result.duplicates++
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
        description: description,
        // Immutable bank/PSD2 original: captured once, never overwritten by a
        // title edit. Equals description at insert; they diverge only if the
        // user later edits the title.
        original_description: description,
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
