/**
 * Match on arrival: look in the bank for the payment of an inbox item, and
 * record the answer on the item as a proposal (invoice_inbox_items.bank_match_*,
 * migration 20261017010000). Never a link and never a booking: a person
 * confirms it, through the doors that already book an underlag against a bank
 * row.
 *
 * Two triggers:
 *   - an item arrives with its reading, or its reading changes (the doors call
 *     refreshInboxItemBankMatch through lib/operations/inbox-bank-match.ts);
 *   - bank rows arrive (transaction.synced): the open items whose amount one
 *     of the new rows could pay are looked at again
 *     (refreshInboxBankMatchesForTransactions).
 *
 * The answer is rewritten only when it changes. A read failure throws: the
 * callers are best effort and log it, since a proposal is a hint and never
 * the item itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateMerchantSimilarity, CONVERTED_AMOUNT_TOLERANCE_PERCENT } from '@/lib/documents/core-receipt-matcher'
import {
  bankMatchSourceKey,
  isOpenInboxItem,
  searchProposableBankRows,
  type BankMatchItemRow,
} from '@/lib/documents/inbox-bank-match'
import { loadDocumentReading, type PeppolReader } from '@/lib/documents/reading/load'
import type { ReadingItemRow } from '@/lib/documents/reading/resolve'
import { underlagPaymentFacts } from '@/lib/documents/underlag-bank-candidates'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { InvoiceExtractionResult } from '@/types'
import { decideBankMatch, NAME_AGREEMENT, type BankMatchDecision, type BankMatchRules } from './decide'
import { bankMatchFacts, searchRange, type SupplierCardForMatch } from './facts'

/** The rules, plus the reading's Peppol reader (the invoicing block's, passed in like the rest). */
export interface BankMatchRefreshRules extends BankMatchRules {
  peppolReader?: PeppolReader
}

export interface BankMatchRefreshDeps {
  /** Riksbanken's rate for a currency on a day, or null. Defaults to fetchExchangeRate with the cache. */
  rateFor?: (currency: string, isoDate: string) => Promise<number | null>
  /** Today in Stockholm, YYYY-MM-DD. */
  today?: string
}

export type BankMatchRefreshOutcome =
  | { status: 'not_found' }
  /** Converted, booked, paired with a bank row, or moved to Arkiv: nothing to propose. */
  | { status: 'closed' }
  /** Still being read: the reading's own arrival will ask again. */
  | { status: 'pending' }
  | { status: 'unchanged' | 'updated'; decision: BankMatchDecision | null }

interface ItemRow extends BankMatchItemRow, ReadingItemRow {
  status: string | null
  created_at: string
  bank_match_checked_at: string | null
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`inbox bank match: ${what} failed: ${error.message}`)
}

async function supplierCard(supabase: SupabaseClient, companyId: string, supplierId: string | null | undefined): Promise<SupplierCardForMatch | null> {
  if (!supplierId) return null
  const { data, error } = await supabase
    .from('suppliers')
    .select('name, bankgiro, plusgiro')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) fail('supplier read', error)
  return (data as SupplierCardForMatch | null) ?? null
}

function defaultRateFor(supabase: SupabaseClient) {
  return async (currency: string, isoDate: string): Promise<number | null> => {
    const rate = await fetchExchangeRate(currency, new Date(`${isoDate}T12:00:00Z`), supabase)
    return rate && rate.rate > 0 ? rate.rate : null
  }
}

/**
 * Look in the bank for this item's payment and record the answer. Reads the
 * item, its one reading and its supplier card, the bank rows nothing else
 * claims around its dates, and decides (./decide.ts).
 */
export async function refreshInboxItemBankMatch(
  supabase: SupabaseClient,
  companyId: string,
  inboxItemId: string,
  rules: BankMatchRefreshRules,
  deps: BankMatchRefreshDeps = {},
): Promise<BankMatchRefreshOutcome> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, status, source, document_id, extracted_data, extraction_skipped, kind_hint, channel_context, email_from, email_received_at, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, routed_to_arkiv_at, created_at, bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_checked_at, bank_match_source_key')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) fail('inbox item read', error)
  const item = data as ItemRow | null
  if (!item) return { status: 'not_found' }
  if (item.status === 'processing') return { status: 'pending' }
  if (!isOpenInboxItem(item)) return { status: 'closed' }

  const today = deps.today ?? todayIsoStockholm()
  const [reading, supplier] = await Promise.all([
    loadDocumentReading(supabase, companyId, { item }, rules.peppolReader),
    supplierCard(supabase, companyId, item.matched_supplier_id),
  ])
  const arrivedOn = item.created_at ? todayIsoStockholm(new Date(item.created_at)) : today
  const facts = bankMatchFacts(reading, supplier, arrivedOn)

  let decision: BankMatchDecision | null = null
  if (facts) {
    // Its kronor value: itself for a kronor document, through Riksbanken's
    // rate on its date otherwise, none when no rate can be had.
    let amountSek = isKronorCurrency(facts.currency) ? facts.amount : null
    if (amountSek === null) {
      const rate = await (deps.rateFor ?? defaultRateFor(supabase))(facts.currency, facts.issueDate ?? arrivedOn)
      amountSek = rate != null ? roundOre(facts.amount * rate) : null
    }
    const range = searchRange(facts, today)
    const rows = await searchProposableBankRows(supabase, companyId, {
      inboxItemId: item.id,
      documentId: item.document_id ?? null,
      direction: facts.direction,
      from: range.from,
      to: range.to,
      currency: facts.currency,
      amount: facts.amount,
      amountSek,
      convertedTolerance: CONVERTED_AMOUNT_TOLERANCE_PERCENT,
    })
    decision = decideBankMatch(facts, rows, rules, amountSek)
  }

  const sourceKey = bankMatchSourceKey(item)
  const unchanged =
    item.bank_match_checked_at != null &&
    item.bank_match_source_key === sourceKey &&
    (item.bank_match_transaction_id ?? null) === (decision?.transactionId ?? null) &&
    (item.bank_match_basis ?? null) === (decision?.basis ?? null) &&
    (item.bank_match_evidence_level ?? null) === (decision?.evidenceLevel ?? null)
  if (unchanged) return { status: 'unchanged', decision }

  // Only while the item is still open: a booking or a pairing that landed
  // since the read wins, and its item keeps no proposal.
  const { error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({
      bank_match_transaction_id: decision?.transactionId ?? null,
      bank_match_basis: decision?.basis ?? null,
      bank_match_evidence_level: decision?.evidenceLevel ?? null,
      bank_match_checked_at: new Date().toISOString(),
      bank_match_source_key: sourceKey,
    })
    .eq('id', item.id)
    .eq('company_id', companyId)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .is('routed_to_arkiv_at', null)
  if (updateError) fail('proposal write', updateError)
  return { status: 'updated', decision }
}

/** A bank row as transaction.synced carries it, as far as the pre-check reads it. */
export interface ArrivedBankRow {
  id: string
  company_id?: string | null
  amount: number
  currency?: string | null
  journal_entry_id?: string | null
  is_ignored?: boolean | null
  merchant_name?: string | null
  description?: string | null
}

/** Open items read per bank arrival, newest first. */
export const OPEN_ITEMS_SCANNED = 300
/** Items looked at again per bank arrival: a first sync of 90 days must not hold the sync for minutes. */
export const ITEMS_REFRESHED_PER_ARRIVAL = 20

interface OpenItemRow {
  id: string
  extracted_data: unknown
}

/**
 * Whether one of the arrived rows could be this item's payment: the same
 * amount in the same currency, or, in another currency, a row naming its
 * supplier (the amount is then compared through the rate by the refresh).
 * A cheap superset of what the refresh can propose, read off the item's own
 * extracted_data (lib/documents/underlag-bank-candidates.ts).
 */
export function mayBePaidBy(extracted: unknown, rows: readonly ArrivedBankRow[]): boolean {
  const read = (extracted ?? null) as InvoiceExtractionResult | null
  const total = read?.totals?.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total === 0) return false
  const facts = underlagPaymentFacts(read)
  return rows.some((row) => {
    const currency = (row.currency ?? 'SEK').toUpperCase()
    if (currency === facts.currency) return Math.abs(Math.abs(Number(row.amount)) - Math.abs(total)) <= 0.01
    if (!facts.supplier) return false
    return [row.merchant_name, row.description].some((t) => !!t && calculateMerchantSimilarity(facts.supplier as string, t) >= NAME_AGREEMENT)
  })
}

/**
 * Bank rows arrived: look again at the open items one of them could pay.
 * One item that cannot be read does not stop the others: it is counted in
 * `failed` and keeps the answer it had.
 */
export async function refreshInboxBankMatchesForTransactions(
  supabase: SupabaseClient,
  companyId: string,
  transactions: readonly ArrivedBankRow[],
  rules: BankMatchRefreshRules,
  deps: BankMatchRefreshDeps = {},
): Promise<{ items_checked: number; failed: number }> {
  const rows = transactions.filter(
    (t) => (!t.company_id || t.company_id === companyId) && !t.journal_entry_id && !t.is_ignored && Number(t.amount) !== 0,
  )
  if (rows.length === 0) return { items_checked: 0, failed: 0 }

  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, extracted_data')
    .eq('company_id', companyId)
    .eq('status', 'received')
    .not('document_id', 'is', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .is('routed_to_arkiv_at', null)
    .order('created_at', { ascending: false })
    .limit(OPEN_ITEMS_SCANNED)
  if (error) fail('open inbox item read', error)

  const candidates = ((data ?? []) as OpenItemRow[]).filter((item) => mayBePaidBy(item.extracted_data, rows)).slice(0, ITEMS_REFRESHED_PER_ARRIVAL)
  let failed = 0
  for (const item of candidates) {
    try {
      await refreshInboxItemBankMatch(supabase, companyId, item.id, rules, deps)
    } catch {
      failed++
    }
  }
  return { items_checked: candidates.length, failed }
}
