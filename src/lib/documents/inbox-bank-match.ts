/**
 * Match on arrival, the ledger's half: what a bank-match proposal on an inbox
 * item looks like, which bank rows may be proposed at all, and the read every
 * inbox surface shows (the dashboard item, v1 GET /inbox-items/{id}, MCP
 * gnubok_get_inbox_item).
 *
 * The proposal says "this invoice or receipt looks already paid by that bank
 * row". It is stored on the item (invoice_inbox_items.bank_match_*, migration
 * 20261017010000) by the inbox block (lib/documents/bank-match), never as a
 * link and never as a booking: matched_transaction_id stays the pairing a
 * person or an agent made.
 *
 * A bank row may be proposed only while nothing else claims it:
 *   - unbooked by all three anchors of lib/transactions/is-booked.ts (the
 *     pointer, a transaction_voucher_links row, a payment row), the same
 *     predicate as public.is_transaction_booked;
 *   - not ignored, not linked to an invoice, a supplier invoice or a receipt;
 *   - carrying no suggestion of the bank feed's own matchers (an invoice, a
 *     supplier invoice, a verifikat, a ROT/RUT payout or a Bankgirot split):
 *     their answer comes first, and a second proposal for the same row is how
 *     one payment gets booked twice;
 *   - holding no other document, and paired with no other inbox item.
 * The read checks the row again, so a proposal whose row was booked or
 * claimed since it was written is never shown, and neither is one whose item
 * no longer reads the same (bankMatchSourceKey) or is no longer open.
 *
 * No server-only imports beyond the client type.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { RULE_LINK_BASES, type LinkEvidence } from '@/lib/links/link-basis'
import { isKronorCurrency, resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'

/** How far a proposal can be trusted: never a score, always what agreed. */
export const BANK_MATCH_EVIDENCE_LEVELS = ['exakt', 'stark', 'trolig'] as const
export type BankMatchEvidenceLevel = (typeof BANK_MATCH_EVIDENCE_LEVELS)[number]

/** What paired the proposal, in the link-basis vocabulary (lib/links/link-basis.ts). */
export const BANK_MATCH_BASES = RULE_LINK_BASES
export type BankMatchBasis = (typeof RULE_LINK_BASES)[number]

export function isBankMatchEvidenceLevel(value: unknown): value is BankMatchEvidenceLevel {
  return typeof value === 'string' && (BANK_MATCH_EVIDENCE_LEVELS as readonly string[]).includes(value)
}

export function isBankMatchBasis(value: unknown): value is BankMatchBasis {
  return typeof value === 'string' && (BANK_MATCH_BASES as readonly string[]).includes(value)
}

/** The proposal as every read answers it. */
export interface BankMatch {
  transaction_id: string
  date: string
  /** As the bank row carries it: signed, in `currency`. */
  amount: number
  currency: string
  /** What the bank row says about the other party (merchant name, else its text). */
  counterparty: string | null
  basis: BankMatchBasis
  evidence_level: BankMatchEvidenceLevel
}

export const BankMatchSchema = z
  .object({
    transaction_id: z.string().uuid().describe('The bank transaction that looks like the payment (GET /transactions/{id}).'),
    date: z.string().describe('The bank row\'s date, YYYY-MM-DD.'),
    amount: z.number().describe('The bank row\'s amount, signed (a payment is below zero), in currency.'),
    currency: z.string().describe('The bank row\'s currency.'),
    counterparty: z.string().nullable().describe('What the bank row says about the other party.'),
    basis: z
      .enum(BANK_MATCH_BASES)
      .describe('What paired them: rule_ocr_reference (the OCR), rule_counterparty (the payee\'s bankgiro or plusgiro), rule_amount_date (amount and date, with the name or the card that paid it).'),
    evidence_level: z
      .enum(BANK_MATCH_EVIDENCE_LEVELS)
      .describe('exakt: OCR and amount agree. stark: amount and the payee\'s giro agree in the payment window (or amount, window, name and the card that paid it). trolig: amount, the payment window and the name agree, or the name is missing and the bank row names the card the document was paid with. Never a score.'),
  })
  .describe('A proposal, never a booking: the item looks already paid by this bank row.')

/** The inbox item columns the proposal is read from. */
export interface BankMatchItemRow {
  id: string
  document_id?: string | null
  extracted_data?: unknown
  kind_hint?: string | null
  matched_supplier_id?: string | null
  matched_transaction_id?: string | null
  created_supplier_invoice_id?: string | null
  created_journal_entry_id?: string | null
  routed_to_arkiv_at?: string | null
  bank_match_transaction_id?: string | null
  bank_match_basis?: string | null
  bank_match_evidence_level?: string | null
  bank_match_source_key?: string | null
}

/** Not yet a supplier invoice, a verifikat, a pairing or an Arkiv document: still waiting in the Inkorg. */
export function isOpenInboxItem(item: BankMatchItemRow): boolean {
  return !item.created_supplier_invoice_id && !item.created_journal_entry_id && !item.matched_transaction_id && !item.routed_to_arkiv_at
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(record: unknown, key: string): unknown {
  return isRecord(record) ? (record[key] ?? null) : null
}

/** Keys sorted, so the same values always print the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** FNV-1a, 32 bits: a fingerprint, not a secret. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * A fingerprint of what the proposal was computed from: the reading's fields
 * the matcher reads (supplier name and giro, the dates, the currency, the
 * OCR, the totals, the kind) plus the declared kind, the matched supplier and
 * the document. Anything else on the reading (a purchase category, the
 * lines) leaves it unchanged, so choosing a category never hides a proposal,
 * while a corrected amount or OCR does until the matcher looks again.
 */
export function bankMatchSourceKey(item: BankMatchItemRow): string {
  const read = item.extracted_data
  const supplier = pick(read, 'supplier')
  const invoice = pick(read, 'invoice')
  const totals = pick(read, 'totals')
  const projection = {
    supplier: [pick(supplier, 'name'), pick(supplier, 'bankgiro'), pick(supplier, 'plusgiro')],
    invoice: [pick(invoice, 'invoiceDate'), pick(invoice, 'dueDate'), pick(invoice, 'currency'), pick(invoice, 'paymentReference')],
    totals: [pick(totals, 'total'), pick(totals, 'subtotal'), pick(totals, 'vatAmount')],
    kind: [pick(read, 'documentKind'), pick(read, 'totalSource'), item.kind_hint ?? null],
    supplier_id: item.matched_supplier_id ?? null,
    document_id: item.document_id ?? null,
  }
  return `v1:${fnv1a(stableJson(projection))}`
}

export interface StoredBankMatch {
  transactionId: string
  basis: BankMatchBasis
  evidenceLevel: BankMatchEvidenceLevel
}

/**
 * The proposal stored on the item, when it still stands as far as the item
 * alone can tell: the item is open, every part is there, and the item reads
 * as it did when the proposal was written. The bank row is checked by
 * readInboxBankMatch.
 */
export function storedBankMatch(item: BankMatchItemRow): StoredBankMatch | null {
  if (!isOpenInboxItem(item)) return null
  const transactionId = item.bank_match_transaction_id ?? null
  if (!transactionId) return null
  if (!isBankMatchBasis(item.bank_match_basis) || !isBankMatchEvidenceLevel(item.bank_match_evidence_level)) return null
  if (item.bank_match_source_key !== bankMatchSourceKey(item)) return null
  return { transactionId, basis: item.bank_match_basis, evidenceLevel: item.bank_match_evidence_level }
}

/**
 * What a booking of the proposed pair records on its links: the rule that
 * proposed it (lib/links/link-basis.ts: a suggestion a person confirmed keeps
 * the suggesting rule as evidence). Undefined for any other bank row.
 */
export function bankMatchLinkEvidence(item: BankMatchItemRow, transactionId: string | null | undefined): LinkEvidence | undefined {
  if (!transactionId || item.bank_match_transaction_id !== transactionId || !isBankMatchBasis(item.bank_match_basis)) return undefined
  return { rule_id: `inbox_bank_match:${item.bank_match_basis}` }
}

/** A bank row as the matcher compares it. */
export interface ProposableBankRow {
  id: string
  date: string
  amount: number
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
  description: string | null
  original_description: string | null
  merchant_name: string | null
  reference: string | null
  counterparty_account: string | null
}

/** A bank row with the columns that say whether something already claims it. */
interface BankRowState extends ProposableBankRow {
  journal_entry_id: string | null
  is_ignored: boolean | null
  invoice_id: string | null
  supplier_invoice_id: string | null
  receipt_id: string | null
  document_id: string | null
  potential_invoice_id: string | null
  potential_supplier_invoice_id: string | null
  potential_journal_entry_id: string | null
  potential_rot_rut_payout_request_id: string | null
  potential_match_method: string | null
  transaction_voucher_links?: Array<{ journal_entry_id: string | null; role?: string | null }> | null
}

/** What the row itself says: nothing books, links or suggests it, and it holds no other document. */
function rowIsFree(row: BankRowState, documentId: string | null): boolean {
  if (row.journal_entry_id || row.is_ignored) return false
  if (row.invoice_id || row.supplier_invoice_id || row.receipt_id) return false
  if (row.potential_invoice_id || row.potential_supplier_invoice_id || row.potential_journal_entry_id) return false
  if (row.potential_rot_rut_payout_request_id || row.potential_match_method) return false
  if (Array.isArray(row.transaction_voucher_links) && row.transaction_voucher_links.length > 0) return false
  if (row.document_id && row.document_id !== documentId) return false
  return Number.isFinite(Number(row.amount)) && Number(row.amount) !== 0
}

function toProposable(row: BankRowState): ProposableBankRow {
  return {
    id: row.id,
    date: row.date,
    amount: Number(row.amount),
    currency: row.currency ?? null,
    amount_sek: row.amount_sek == null ? null : Number(row.amount_sek),
    exchange_rate: row.exchange_rate == null ? null : Number(row.exchange_rate),
    description: row.description ?? null,
    original_description: row.original_description ?? null,
    merchant_name: row.merchant_name ?? null,
    reference: row.reference ?? null,
    counterparty_account: row.counterparty_account ?? null,
  }
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`inbox bank match: ${what} failed: ${error.message}`)
}

/** Ids per `.in()` filter, so a whole list's request line stays well inside URL limits. */
const ID_CHUNK = 100

function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/**
 * What claims the bank rows `ids` from outside the row: the rows a payment
 * row books (invoice_payments, supplier_invoice_payments, the multi-allocation
 * anchor), and the inbox items paired with each row.
 */
async function claimsOn(
  supabase: SupabaseClient,
  companyId: string,
  ids: readonly string[],
): Promise<{ paid: Set<string>; pairedWith: Map<string, string[]> }> {
  const paid = new Set<string>()
  const pairedWith = new Map<string, string[]>()
  for (const part of chunked(ids)) {
    const [customerPayments, supplierPayments, pairedItems] = await Promise.all([
      supabase.from('invoice_payments').select('transaction_id').eq('company_id', companyId).in('transaction_id', part),
      supabase.from('supplier_invoice_payments').select('transaction_id').eq('company_id', companyId).in('transaction_id', part),
      supabase.from('invoice_inbox_items').select('id, matched_transaction_id').eq('company_id', companyId).in('matched_transaction_id', part),
    ])
    if (customerPayments.error) fail('invoice payment read', customerPayments.error)
    if (supplierPayments.error) fail('supplier payment read', supplierPayments.error)
    if (pairedItems.error) fail('paired inbox item read', pairedItems.error)
    for (const row of (customerPayments.data ?? []) as Array<{ transaction_id: string | null }>) if (row.transaction_id) paid.add(row.transaction_id)
    for (const row of (supplierPayments.data ?? []) as Array<{ transaction_id: string | null }>) if (row.transaction_id) paid.add(row.transaction_id)
    for (const row of (pairedItems.data ?? []) as Array<{ id: string; matched_transaction_id: string | null }>) {
      if (!row.matched_transaction_id) continue
      pairedWith.set(row.matched_transaction_id, [...(pairedWith.get(row.matched_transaction_id) ?? []), row.id])
    }
  }
  return { paid, pairedWith }
}

/** Claimed for `inboxItemId`: a payment row books it, or another inbox item is paired with it. */
function claimedFor(claims: { paid: Set<string>; pairedWith: Map<string, string[]> }, rowId: string, inboxItemId: string): boolean {
  return claims.paid.has(rowId) || (claims.pairedWith.get(rowId) ?? []).some((id) => id !== inboxItemId)
}

/**
 * The rows among `rows` that nothing outside the row claims: no payment row
 * and no other inbox item paired with it.
 */
async function unclaimed(
  supabase: SupabaseClient,
  companyId: string,
  rows: BankRowState[],
  inboxItemId: string,
): Promise<BankRowState[]> {
  if (rows.length === 0) return rows
  const claims = await claimsOn(supabase, companyId, rows.map((row) => row.id))
  return rows.filter((row) => !claimedFor(claims, row.id, inboxItemId))
}

/** Where the matcher looks for an item's payment. */
export interface BankRowSearch {
  inboxItemId: string
  documentId: string | null
  /** out: money left the company (an invoice, a receipt); in: it came back (a credit note, a refund). */
  direction: 'out' | 'in'
  /** The bank-row dates to look at, YYYY-MM-DD, inclusive. */
  from: string
  to: string
  /** The document's currency, upper-case, and its amount as a magnitude. */
  currency: string
  amount: number
  /** The document's amount in kronor, when it is known: rows in another currency are compared through it. */
  amountSek: number | null
  /** How far a row in another currency may sit from amountSek, relative. */
  convertedTolerance: number
}

/** Rows a same-unit comparison can find: a hair over the matchers' half-öre. */
const SAME_CURRENCY_BAND = 0.01
const SEARCH_LIMIT = 50

function sekMagnitude(row: ProposableBankRow): number | null {
  const sek = resolveSekAmountOrNull(row.amount, row.amount_sek, row.currency, row.exchange_rate)
  return sek === null ? null : Math.abs(sek)
}

/**
 * The bank rows in the window that could be the payment and that nothing
 * claims: rows in the document's currency within a hair of its amount, and,
 * when its kronor value is known, rows in another currency within the
 * converted tolerance of it. Throws on a failed read.
 */
export async function searchProposableBankRows(
  supabase: SupabaseClient,
  companyId: string,
  search: BankRowSearch,
): Promise<ProposableBankRow[]> {
  const sign = search.direction === 'out' ? -1 : 1
  const signed = (low: number, high: number): [number, number] =>
    sign < 0 ? [-high, -low] : [low, high]

  const [sameLow, sameHigh] = signed(Math.max(0, search.amount - SAME_CURRENCY_BAND), search.amount + SAME_CURRENCY_BAND)
  const sameQuery = supabase
    .from('transactions')
    .select('id, date, amount, currency, amount_sek, exchange_rate, description, original_description, merchant_name, reference, counterparty_account, journal_entry_id, is_ignored, invoice_id, supplier_invoice_id, receipt_id, document_id, potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_rot_rut_payout_request_id, potential_match_method, transaction_voucher_links(journal_entry_id, role)')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
    .gte('date', search.from)
    .lte('date', search.to)
    .gte('amount', sameLow)
    .lte('amount', sameHigh)
  const kronor = isKronorCurrency(search.currency)
  const sameRows =
    kronor
      ? await sameQuery.or('currency.is.null,currency.eq.SEK').order('date', { ascending: true }).limit(SEARCH_LIMIT)
      : await sameQuery.eq('currency', search.currency).order('date', { ascending: true }).limit(SEARCH_LIMIT)
  if (sameRows.error) fail('bank row read', sameRows.error)
  const rows = [...((sameRows.data ?? []) as unknown as BankRowState[])]

  if (search.amountSek != null && search.amountSek > 0) {
    const low = search.amountSek * (1 - search.convertedTolerance)
    const high = search.amountSek * (1 + search.convertedTolerance)
    if (kronor) {
      // A kronor document against rows in another currency: their kronor value decides, read below.
      const foreign = await supabase
        .from('transactions')
        .select('id, date, amount, currency, amount_sek, exchange_rate, description, original_description, merchant_name, reference, counterparty_account, journal_entry_id, is_ignored, invoice_id, supplier_invoice_id, receipt_id, document_id, potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_rot_rut_payout_request_id, potential_match_method, transaction_voucher_links(journal_entry_id, role)')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_ignored', false)
        .neq('currency', 'SEK')
        .gte('date', search.from)
        .lte('date', search.to)
        .order('date', { ascending: true })
        .limit(SEARCH_LIMIT)
      if (foreign.error) fail('foreign bank row read', foreign.error)
      for (const row of (foreign.data ?? []) as unknown as BankRowState[]) {
        if (Math.sign(Number(row.amount)) !== sign) continue
        const sek = sekMagnitude(toProposable(row))
        if (sek != null && sek >= low && sek <= high) rows.push(row)
      }
    } else {
      // A foreign document against kronor rows: their amount is their kronor value.
      const [kronorLow, kronorHigh] = signed(low, high)
      const kronorRows = await supabase
        .from('transactions')
        .select('id, date, amount, currency, amount_sek, exchange_rate, description, original_description, merchant_name, reference, counterparty_account, journal_entry_id, is_ignored, invoice_id, supplier_invoice_id, receipt_id, document_id, potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_rot_rut_payout_request_id, potential_match_method, transaction_voucher_links(journal_entry_id, role)')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_ignored', false)
        .or('currency.is.null,currency.eq.SEK')
        .gte('date', search.from)
        .lte('date', search.to)
        .gte('amount', kronorLow)
        .lte('amount', kronorHigh)
        .order('date', { ascending: true })
        .limit(SEARCH_LIMIT)
      if (kronorRows.error) fail('kronor bank row read', kronorRows.error)
      rows.push(...((kronorRows.data ?? []) as unknown as BankRowState[]))
    }
  }

  const seen = new Set<string>()
  const free = rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return rowIsFree(row, search.documentId)
  })
  return (await unclaimed(supabase, companyId, free, search.inboxItemId)).map(toProposable)
}

/**
 * The proposal to show for an item, or null: none stored, the item no longer
 * open or no longer reading the same, or its bank row booked, gone or claimed
 * by something else since. Throws on a failed read; every caller answers
 * null then, since the proposal is a hint and never the item itself.
 */
export async function readInboxBankMatch(
  supabase: SupabaseClient,
  companyId: string,
  item: BankMatchItemRow,
): Promise<BankMatch | null> {
  const stored = storedBankMatch(item)
  if (!stored) return null
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, currency, amount_sek, exchange_rate, description, original_description, merchant_name, reference, counterparty_account, journal_entry_id, is_ignored, invoice_id, supplier_invoice_id, receipt_id, document_id, potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_rot_rut_payout_request_id, potential_match_method, transaction_voucher_links(journal_entry_id, role)')
    .eq('id', stored.transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) fail('proposed bank row read', error)
  const row = data as unknown as BankRowState | null
  if (!row || !rowIsFree(row, item.document_id ?? null)) return null
  const [free] = await unclaimed(supabase, companyId, [row], item.id)
  if (!free) return null
  return toBankMatch(free, stored)
}

function toBankMatch(row: BankRowState, stored: StoredBankMatch): BankMatch {
  return {
    transaction_id: row.id,
    date: row.date,
    amount: Number(row.amount),
    currency: (row.currency ?? 'SEK').toUpperCase(),
    counterparty: row.merchant_name?.trim() || row.description?.trim() || null,
    basis: stored.basis,
    evidence_level: stored.evidenceLevel,
  }
}

/**
 * The proposals of a whole list of items at once (the Inkorg's list), by
 * item id, with the same checks as readInboxBankMatch: the bank rows the
 * standing proposals name are read together, then what else claims them,
 * so the number of reads does not grow with the list (one per hundred
 * proposals, none without any). Items without a proposal that still stands
 * are absent. Throws on a failed read; the list answers without proposals
 * then, since a proposal is a hint and never the item itself.
 */
export async function readInboxBankMatches(
  supabase: SupabaseClient,
  companyId: string,
  items: readonly BankMatchItemRow[],
): Promise<Map<string, BankMatch>> {
  const out = new Map<string, BankMatch>()
  const standing = items.flatMap((item) => {
    const stored = storedBankMatch(item)
    return stored ? [{ item, stored }] : []
  })
  if (standing.length === 0) return out

  const rowOf = new Map<string, BankRowState>()
  for (const ids of chunked([...new Set(standing.map((s) => s.stored.transactionId))])) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, date, amount, currency, amount_sek, exchange_rate, description, original_description, merchant_name, reference, counterparty_account, journal_entry_id, is_ignored, invoice_id, supplier_invoice_id, receipt_id, document_id, potential_invoice_id, potential_supplier_invoice_id, potential_journal_entry_id, potential_rot_rut_payout_request_id, potential_match_method, transaction_voucher_links(journal_entry_id, role)')
      .eq('company_id', companyId)
      .in('id', ids)
    if (error) fail('proposed bank rows read', error)
    for (const row of (data ?? []) as unknown as BankRowState[]) rowOf.set(row.id, row)
  }

  const free = standing.flatMap(({ item, stored }) => {
    const row = rowOf.get(stored.transactionId)
    return row && rowIsFree(row, item.document_id ?? null) ? [{ item, stored, row }] : []
  })
  if (free.length === 0) return out
  const claims = await claimsOn(supabase, companyId, [...new Set(free.map((f) => f.row.id))])
  for (const { item, stored, row } of free) {
    if (!claimedFor(claims, row.id, item.id)) out.set(item.id, toBankMatch(row, stored))
  }
  return out
}
