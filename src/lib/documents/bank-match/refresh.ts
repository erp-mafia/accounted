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
 * A late payment (./decide.ts) is weighed against the other open items the
 * row could pay, each read as it reads itself; and once an item's answer is
 * written, the other items whose standing proposal names a row it could
 * claim are looked at again, so a late claim of theirs that this item holds
 * better (it arrived later, or reads differently now) is withdrawn.
 *
 * The answer is rewritten only when it changes. A read failure throws: the
 * callers are best effort and log it, since a proposal is a hint and never
 * the item itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateMerchantSimilarity, CONVERTED_AMOUNT_TOLERANCE_PERCENT } from '@/lib/documents/core-receipt-matcher'
import {
  bankMatchCheckKey,
  searchProposableBankRows,
  type BankMatchItemRow,
  type ProposableBankRow,
} from '@/lib/documents/inbox-bank-match'
import { loadDocumentReading, type PeppolReader } from '@/lib/documents/reading/load'
import type { ReadingItemRow } from '@/lib/documents/reading/resolve'
import { underlagPaymentFacts } from '@/lib/documents/underlag-bank-candidates'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { isKronorCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { InvoiceExtractionResult } from '@/types'
import { INBOX_ITEM_DOCUMENT_HOLD, isOpenInboxItem, whereInboxItemOpen, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import { pairInboxItems } from '@/lib/inkorg/pairs'
import { readDeliverySiblings, type PairableRow } from '@/lib/inkorg/pairs-read'
import { normaliseCardLast4 } from './card-token'
import { readKnownCards } from './known-cards'
import { bankRowClaims, decideBankMatch, NAME_AGREEMENT, type BankMatchDecision, type BankMatchRival, type BankMatchRules } from './decide'
import { bankMatchFacts, searchRange, type BankMatchFacts, type SupplierCardForMatch } from './facts'

/** The rules, plus the reading's Peppol reader (the invoicing block's, passed in like the rest). */
export interface BankMatchRefreshRules extends BankMatchRules {
  peppolReader?: PeppolReader
}

export interface BankMatchRefreshDeps {
  /** Riksbanken's rate for a currency on a day, or null. Defaults to fetchExchangeRate with the cache. */
  rateFor?: (currency: string, isoDate: string) => Promise<number | null>
  /** Today in Stockholm, YYYY-MM-DD. */
  today?: string
  /**
   * After the answer is written, look again at the other open items whose
   * standing proposal names a row this item could claim (on unless false).
   * Off for those looks themselves, which look no further, and for the
   * bank-arrival scan, which looks at every item a new row could pay.
   */
  recheckOthers?: boolean
  /** The open items already read (the bank-arrival scan), so a late claim's rivals are not read again. */
  openItems?: readonly OpenInboxItemRow[]
}

export type BankMatchRefreshOutcome =
  | { status: 'not_found' }
  /** Converted, booked, paired with a bank row, or moved to Arkiv: nothing to propose. */
  | { status: 'closed' }
  /** Still being read: the reading's own arrival will ask again. */
  | { status: 'pending' }
  | {
      status: 'unchanged' | 'updated'
      decision: BankMatchDecision | null
      /** The other items looked at again after the write, and how many of those looks failed (absent when none was). */
      others?: { checked: number; failed: number }
    }

const ITEM_COLUMNS = 'id, status, source, document_id, extracted_data, extraction_skipped, kind_hint, channel_context, email_from, email_received_at, resend_email_id, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, routed_to_arkiv_at, created_at, bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_checked_at, bank_match_source_key'

/** An open inbox item as a check reads it: the reading's columns, the proposal's, and whether it is open. */
export interface OpenInboxItemRow extends BankMatchItemRow, ReadingItemRow, DocumentHoldRow {
  status: string | null
  created_at: string
  bank_match_checked_at: string | null
  resend_email_id?: string | null
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

/** The card a reading says paid it (extracted_data.payment.cardLast4), or null. */
function cardOf(extracted: unknown): string | null {
  const payment = (extracted as InvoiceExtractionResult | null)?.payment
  return normaliseCardLast4(payment?.cardLast4 ?? null)
}

/**
 * The card number the purchase was read as paid with: the item's own reading
 * says so (a receipt), or the receipt it came with as one purchase does (an
 * invoice whose mail carried its receipt, lib/inkorg/pairs.ts). Best effort:
 * a pairing that cannot be read is no card.
 */
async function readPaymentCard(supabase: SupabaseClient, companyId: string, item: OpenInboxItemRow, kind: string): Promise<string | null> {
  const own = cardOf(item.extracted_data)
  if (own || kind !== 'supplier_invoice') return own
  try {
    const { items, arrivalIds } = await readDeliverySiblings(supabase, companyId, item as unknown as PairableRow)
    if (items.length < 2) return null
    const pairing = pairInboxItems(items, { arrivalIds }).get(item.id)
    if (pairing?.role !== 'invoice') return null
    return cardOf(items.find((other) => other.id === pairing.receipt_item_id)?.extracted_data)
  } catch {
    return null
  }
}

/**
 * The card that paid the purchase, as far as matching may lean on it: the
 * read number only when it is one of the company's own cards (./known-cards.ts).
 * A misread number (crm#1534) would otherwise contradict, and so turn away,
 * the very row its real card paid. Best effort: a check that cannot be read
 * is no card.
 */
async function paymentCard(supabase: SupabaseClient, companyId: string, item: OpenInboxItemRow, kind: string): Promise<string | null> {
  const card = await readPaymentCard(supabase, companyId, item, kind)
  if (!card) return null
  try {
    return (await readKnownCards(supabase, companyId, [card])).has(card) ? card : null
  } catch {
    // Safe to ignore: an unchecked card counts as unknown, which only leaves the card out of the match, never makes a wrong one.
    return null
  }
}

function defaultRateFor(supabase: SupabaseClient) {
  return async (currency: string, isoDate: string): Promise<number | null> => {
    const rate = await fetchExchangeRate(currency, new Date(`${isoDate}T12:00:00Z`), supabase)
    return rate && rate.rate > 0 ? rate.rate : null
  }
}

interface ItemFacts {
  facts: BankMatchFacts
  /** Its kronor value: itself for a kronor document, through Riksbanken's rate on its date otherwise, null when no rate can be had. */
  amountSek: number | null
}

/**
 * What an item says about its payment (./facts.ts), from its one reading,
 * its supplier card and the card it was paid with, and its kronor value; null
 * for a document the bank does not pay. The same for the item checked and for
 * every rival it is weighed against, so both sides read one item alike.
 */
async function itemFacts(
  supabase: SupabaseClient,
  companyId: string,
  item: OpenInboxItemRow,
  rules: BankMatchRefreshRules,
  deps: BankMatchRefreshDeps,
  today: string,
): Promise<ItemFacts | null> {
  const [reading, supplier] = await Promise.all([
    loadDocumentReading(supabase, companyId, { item }, rules.peppolReader),
    supplierCard(supabase, companyId, item.matched_supplier_id),
  ])
  const arrivedOn = item.created_at ? todayIsoStockholm(new Date(item.created_at)) : today
  const read = bankMatchFacts(reading, supplier, arrivedOn)
  if (!read) return null
  const facts = { ...read, cardLast4: await paymentCard(supabase, companyId, item, read.kind) }
  let amountSek = isKronorCurrency(facts.currency) ? facts.amount : null
  if (amountSek === null) {
    const rate = await (deps.rateFor ?? defaultRateFor(supabase))(facts.currency, facts.issueDate ?? arrivedOn)
    amountSek = rate != null ? sekOfForeign(facts.amount, rate) : null
  }
  return { facts, amountSek }
}

/** Open items read per bank arrival, and per late claim's rivals, newest first. */
export const OPEN_ITEMS_SCANNED = 300
/** Items looked at again per bank arrival: a first sync of 90 days must not hold the sync for minutes. */
export const ITEMS_REFRESHED_PER_ARRIVAL = 20
/**
 * Rivals read for one item's late claims, at most. More than this many open
 * items with the amount and no late claim is proposed: they cannot all be
 * weighed, and a late claim is the one that must not take another's row.
 */
export const RIVALS_READ = 10
/** Other items looked at again after one item's answer is written. */
export const OTHERS_RECHECKED = 5

/** The open queue: received, with a document, not yet converted, booked, paired or archived. */
async function readOpenItems(supabase: SupabaseClient, companyId: string): Promise<OpenInboxItemRow[]> {
  const { data, error } = await whereInboxItemOpen(
    supabase
      .from('invoice_inbox_items')
      .select(`${ITEM_COLUMNS}, ${INBOX_ITEM_DOCUMENT_HOLD}`)
      .eq('company_id', companyId)
      .eq('status', 'received')
      .not('document_id', 'is', null),
  )
    .order('created_at', { ascending: false })
    .limit(OPEN_ITEMS_SCANNED)
  if (error) fail('open inbox item read', error)
  return ((data ?? []) as unknown as OpenInboxItemRow[]).filter((item) => isOpenInboxItem(withDocumentHold(item)))
}

/**
 * The other open items the contested rows could pay, read as each reads
 * itself; null when they cannot all be weighed (more than RIVALS_READ, or one
 * that cannot be read), and then no late claim is proposed.
 */
async function rivalsFor(
  supabase: SupabaseClient,
  companyId: string,
  item: OpenInboxItemRow,
  contested: readonly ProposableBankRow[],
  rules: BankMatchRefreshRules,
  deps: BankMatchRefreshDeps,
  today: string,
): Promise<BankMatchRival[] | null> {
  const open = deps.openItems ?? (await readOpenItems(supabase, companyId))
  const candidates = open.filter((other) => other.id !== item.id && mayBePaidBy(other.extracted_data, contested))
  if (candidates.length > RIVALS_READ) return null
  const rivals: BankMatchRival[] = []
  for (const other of candidates) {
    let read: ItemFacts | null
    try {
      read = await itemFacts(supabase, companyId, other, rules, deps, today)
    } catch {
      return null
    }
    if (read) rivals.push(read)
  }
  return rivals
}

/**
 * The other open items whose standing proposal names one of `rowIds`, looked
 * at again once, without looking further. One that cannot be read keeps its
 * answer and counts as failed; so does a failed read of who they are.
 */
async function lookAgainAtOthers(
  supabase: SupabaseClient,
  companyId: string,
  itemId: string,
  rowIds: readonly string[],
  rules: BankMatchRefreshRules,
  deps: BankMatchRefreshDeps,
): Promise<{ checked: number; failed: number }> {
  const { data, error } = await whereInboxItemOpen(
    supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', companyId)
      .in('bank_match_transaction_id', rowIds.slice(0, 100))
      .neq('id', itemId),
  ).limit(OTHERS_RECHECKED)
  if (error) return { checked: 0, failed: 1 }
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  let failed = 0
  for (const id of ids) {
    try {
      await refreshInboxItemBankMatch(supabase, companyId, id, rules, { rateFor: deps.rateFor, today: deps.today, recheckOthers: false })
    } catch {
      failed++
    }
  }
  return { checked: ids.length, failed }
}

/**
 * Look in the bank for this item's payment and record the answer. Reads the
 * item, its one reading and its supplier card, the bank rows nothing else
 * claims around its dates, and, for a late payment that could be proposed,
 * the other open items the row could pay; then decides (./decide.ts).
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
    .select(`${ITEM_COLUMNS}, ${INBOX_ITEM_DOCUMENT_HOLD}`)
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) fail('inbox item read', error)
  const item = data as unknown as OpenInboxItemRow | null
  if (!item) return { status: 'not_found' }
  if (item.status === 'processing') return { status: 'pending' }
  if (!isOpenInboxItem(withDocumentHold(item))) return { status: 'closed' }

  const today = deps.today ?? todayIsoStockholm()
  const own = await itemFacts(supabase, companyId, item, rules, deps, today)

  let decision: BankMatchDecision | null = null
  let claimable: string[] = []
  if (own) {
    const range = searchRange(own.facts, today)
    const rows = await searchProposableBankRows(supabase, companyId, {
      inboxItemId: item.id,
      documentId: item.document_id ?? null,
      direction: own.facts.direction,
      from: range.from,
      to: range.to,
      currency: own.facts.currency,
      amount: own.facts.amount,
      amountSek: own.amountSek,
      convertedTolerance: CONVERTED_AMOUNT_TOLERANCE_PERCENT,
    })
    const claims = bankRowClaims(own.facts, rows, rules, own.amountSek)
    claimable = claims.claimable.map((row) => row.id)
    let candidates: readonly ProposableBankRow[] = rows
    let rivals: BankMatchRival[] = []
    if (claims.contested.length > 0) {
      const read = await rivalsFor(supabase, companyId, item, claims.contested, rules, deps, today)
      if (read) {
        rivals = read
      } else {
        // The rivals cannot all be weighed: no late claim, the rest as always.
        const contested = new Set(claims.contested.map((row) => row.id))
        candidates = rows.filter((row) => !contested.has(row.id))
      }
    }
    decision = decideBankMatch(own.facts, candidates, rules, own.amountSek, rivals)
  }

  const sourceKey = bankMatchCheckKey(item)
  const unchanged =
    item.bank_match_checked_at != null &&
    item.bank_match_source_key === sourceKey &&
    (item.bank_match_transaction_id ?? null) === (decision?.transactionId ?? null) &&
    (item.bank_match_basis ?? null) === (decision?.basis ?? null) &&
    (item.bank_match_evidence_level ?? null) === (decision?.evidenceLevel ?? null)
  if (unchanged) return { status: 'unchanged', decision }

  // Only while the item is still open: a booking or a pairing that landed
  // since the read wins, and its item keeps no proposal.
  const { error: updateError } = await whereInboxItemOpen(
    supabase
      .from('invoice_inbox_items')
      .update({
        bank_match_transaction_id: decision?.transactionId ?? null,
        bank_match_basis: decision?.basis ?? null,
        bank_match_evidence_level: decision?.evidenceLevel ?? null,
        bank_match_checked_at: new Date().toISOString(),
        bank_match_source_key: sourceKey,
      })
      .eq('id', item.id)
      .eq('company_id', companyId),
  )
  if (updateError) fail('proposal write', updateError)

  if (deps.recheckOthers === false || claimable.length === 0) return { status: 'updated', decision }
  const others = await lookAgainAtOthers(supabase, companyId, item.id, claimable, rules, deps)
  return others.checked > 0 || others.failed > 0 ? { status: 'updated', decision, others } : { status: 'updated', decision }
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
 * `failed` and keeps the answer it had. The open queue read here is every
 * check's rivals too, and no check looks further: every item a new row could
 * pay is looked at here anyway.
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

  const open = await readOpenItems(supabase, companyId)
  const candidates = open.filter((item) => mayBePaidBy(item.extracted_data, rows)).slice(0, ITEMS_REFRESHED_PER_ARRIVAL)
  let failed = 0
  for (const item of candidates) {
    try {
      await refreshInboxItemBankMatch(supabase, companyId, item.id, rules, { ...deps, recheckOthers: false, openItems: open })
    } catch {
      failed++
    }
  }
  return { items_checked: candidates.length, failed }
}
