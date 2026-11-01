import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsDocument, CollectionsSettlement } from '@accounted/connect-contract'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isAccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { UUID_RE } from '@/lib/invariants/uuid'
import { linkTransactionToJournalEntry } from '@/lib/transactions/link-journal-entry'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { getCollectionsProvider } from './catalogue'
import { bookCollectedPayment, loadUnbookedCollectedPayments, type CollectedPaymentBookingDeps } from './collected-payments'
import { normalizeCollectedPaymentRow } from './collected-payment-record'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { isCollectionsError } from './errors'
import type { CollectionsAdapter, CollectionsRoute } from './port'
import { adapterForConnection, callContext, loadConnectionById } from './service-deps'
import { copyDocumentToVoucher, linkDocumentOnce, type CopyDocumentInput } from './underlag'
import {
  planSettlementVoucher,
  type SettlementLineInput,
  type SettlementLineKind,
  type SettlementLineRecipient,
  type SettlementPlan,
  type SettlementPlanIssue,
} from './settlement-posting'

/**
 * The collections provider's payouts (settlements): import, booking and the
 * acknowledgement back to the provider (build spec 4.2 D, 4.3, 4.4).
 *
 * Import: the payouts since the last one stored (with an overlap) are read
 * through the company's adapter, and each new one is stored once with its
 * lines, each line tied to the case and invoice it belongs to (merged cases
 * through their original invoices). The provider's free text never enters
 * the books or this table: it can name the debtor.
 *
 * Booking (one voucher per payout, source_type collection_settlement, dated
 * the payout day): the cases' collected payments are booked first (step C,
 * collected-payments.ts), then planSettlementVoucher decides every line's
 * account, the balance and the per-case reconciliation. Anything it cannot
 * decide leaves the payout in needs_mapping with the reason, for a person in
 * the settlements view. Before the voucher: a payout already booked by hand
 * (a bank row with the payout's reference and amount that is already on a
 * voucher) is refused as a possible duplicate, and the provider's settlement
 * PDF is archived; it becomes the voucher's underlag. After it: the collected
 * payments it settles are tied to it, and the provider is told the payout is
 * booked (retried by the sync run until it answers).
 *
 * Booking is a person's click, or automatic for companies that turned on
 * auto_book_settlements. Import, booking and the acknowledgement are
 * obligation paths (build spec rule 3): they run whatever the start gates
 * say. Every posting here waits for the accountant's sign-off (build spec
 * 4.5 items 1 and 3 to 8).
 */

const log = createLogger('collections/settlements')

/**
 * Whether the ledger accepts the provider's settlement as a valid VAT
 * invoice for the fees it withholds (build spec 4.5 item 4). Off until the
 * accountant has seen a Swedish sample settlement: until then the VAT on the
 * provider's fees always waits for a person (2641 or 6062), whatever the
 * catalogue's settlementIsVatInvoice says. Turning it on is a reviewed code
 * change, not a setting.
 */
export const SETTLEMENT_VAT_INVOICE_ACCEPTED = false

/** The first import reaches this far back; later ones from the last payout stored, less the overlap. */
export const SETTLEMENT_FIRST_LOOKBACK_DAYS = 120
export const SETTLEMENT_LIST_OVERLAP_DAYS = 14
/** How long one booking holds its payout. */
export const SETTLEMENT_BOOKING_LEASE_MS = 3 * 60_000
/** The duplicate guard looks for a hand-booked payout this many days either side of the payout day. */
export const SETTLEMENT_DUPLICATE_WINDOW_DAYS = 5
/** The payout's bank row is looked for this many days either side of the payout day. */
export const SETTLEMENT_BANK_LINK_WINDOW_DAYS = 3
/** Booked payouts whose bank row has not been found are looked for again this long (the bank feed can lag). */
export const SETTLEMENT_BANK_LINK_RETRY_DAYS = 14

/**
 * A payout's business event for the posting port (sale.payout_settled, as a
 * PSP payout): what the provider collected for the company's invoices,
 * net of what it kept, reaching the bank on the payment date. SEK only (the
 * planner refuses another currency); the amount is the payout. No subject
 * (a settlement has no typed handle; the verifikat's source_id names it) and
 * no party (the provider has no counterparty row). The fees' ingående moms
 * stays in the lines. The underlag is the provider's settlement document.
 * Built only while POSTING_EVENTS is on.
 */
export function collectionSettlementBusinessEvent(
  settlement: Pick<SettlementRow, 'payment_date' | 'amount'>,
  documentId: string | null,
): BusinessEventDraft {
  return {
    kind: 'sale.payout_settled',
    category: null,
    occurredOn: settlement.payment_date,
    currency: 'SEK',
    amount: Math.abs(settlement.amount),
    amountSek: Math.abs(settlement.amount),
    taxAmounts: [],
    evidence: { direction: 'in', document_id: documentId ?? undefined },
    mappingVersion: mappingVersion('collectionsSettlement'),
    jurisdiction: 'SE',
  }
}

export type SettlementStatus = 'received' | 'booked' | 'needs_mapping' | 'failed' | 'ignored'

export interface SettlementRow {
  id: string
  company_id: string
  connection_id: string
  provider_settlement_ref: string
  payment_date: string
  settlement_date: string | null
  amount: number
  currency: string
  provider_status_ok: boolean
  provider_status_code: string | null
  bank_reference: string | null
  status: SettlementStatus
  needs_mapping_reason: string | null
  journal_entry_id: string | null
  document_attachment_id: string | null
  bank_transaction_id: string | null
  provider_acknowledged_at: string | null
  booked_by: string | null
  booked_at: string | null
  booking_lease_until: string | null
  /** A person confirmed the payout is not a duplicate of a voucher booked by hand. */
  duplicate_cleared_by?: string | null
  duplicate_cleared_at?: string | null
  /** A person marked the payout as handled elsewhere (status ignored), with why. */
  ignored_reason?: string | null
  ignored_by?: string | null
  ignored_at?: string | null
  raw: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SettlementLineRow {
  id: string
  company_id: string
  settlement_id: string
  position: number
  kind: SettlementLineKind
  in_payout: boolean
  recipient: SettlementLineRecipient
  amount: number
  tax_amount: number
  provider_case_ref: string | null
  case_id: string | null
  invoice_id: string | null
  original_invoice_ids: string[]
  provider_type: string
  description: string | null
  account_number: string | null
  vat_account_number: string | null
  account_chosen_by: string | null
  booked: boolean
}

export function normalizeSettlementRow(raw: Record<string, unknown>): SettlementRow {
  const row = raw as unknown as SettlementRow
  return { ...row, amount: Number(row.amount) }
}

export function normalizeSettlementLineRow(raw: Record<string, unknown>): SettlementLineRow {
  const row = raw as unknown as SettlementLineRow
  return {
    ...row,
    position: Number(row.position),
    amount: Number(row.amount),
    tax_amount: Number(row.tax_amount ?? 0),
    original_invoice_ids: row.original_invoice_ids ?? [],
  }
}

export interface SettlementServiceDeps {
  /** Service-role client; every query filters on the company. */
  db: SupabaseClient
  now?: () => Date
  log?: Logger
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  /** Overrides the ledger's acceptance of the settlement as a VAT invoice (tests). */
  vatInvoiceAccepted?: boolean
  /** Archives the settlement PDF and answers the document id; default uploadDocument. */
  archiveDocument?: (input: { companyId: string; userId: string; document: CollectionsDocument }) => Promise<string>
  /** Copies the archived settlement PDF onto a C voucher it settles; default copyDocumentToVoucher. */
  copyDocument?: (input: CopyDocumentInput) => Promise<string>
  /** Archives a collected payment's record, passed on to the C bookings (collected-payments.ts). */
  archiveRecord?: CollectedPaymentBookingDeps['archiveRecord']
  /** Links the payout's bank row to the payout voucher; default linkTransactionToJournalEntry. */
  linkBankRow?: typeof linkTransactionToJournalEntry
  /** Books a collected payment (step C) before the payout; default bookCollectedPayment. */
  bookCollected?: typeof bookCollectedPayment
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** The cases of the company by provider reference and by invoice (the newest reachable one per invoice). */
async function loadCaseIndex(
  db: SupabaseClient,
  companyId: string,
  providerRefs: readonly string[],
  invoiceIds: readonly string[],
): Promise<{ byRef: Map<string, { id: string; invoiceId: string }>; byInvoice: Map<string, string> }> {
  const byRef = new Map<string, { id: string; invoiceId: string }>()
  const byInvoice = new Map<string, string>()
  if (providerRefs.length > 0) {
    const { data, error } = await db
      .from('collection_cases')
      .select('id, invoice_id, provider_case_ref')
      .eq('company_id', companyId)
      .in('provider_case_ref', [...providerRefs])
    if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
    for (const c of (data ?? []) as { id: string; invoice_id: string; provider_case_ref: string }[]) {
      byRef.set(c.provider_case_ref, { id: c.id, invoiceId: c.invoice_id })
    }
  }
  if (invoiceIds.length > 0) {
    const { data, error } = await db
      .from('collection_cases')
      .select('id, invoice_id, created_at')
      .eq('company_id', companyId)
      .in('invoice_id', [...invoiceIds])
      .in('submission_status', ['submitted', 'registered'])
      .order('created_at', { ascending: true })
    if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
    // Ascending, so the newest case of an invoice wins.
    for (const c of (data ?? []) as { id: string; invoice_id: string }[]) byInvoice.set(c.invoice_id, c.id)
  }
  return { byRef, byInvoice }
}

/** The invoice ids among `refs` that are the company's own. */
async function ownInvoiceIds(db: SupabaseClient, companyId: string, refs: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(refs.filter((ref) => UUID_RE.test(ref)))]
  if (ids.length === 0) return new Set()
  const { data, error } = await db.from('invoices').select('id').eq('company_id', companyId).in('id', ids)
  if (error) throw new Error(`invoices lookup failed: ${error.message}`)
  return new Set(((data ?? []) as { id: string }[]).map((i) => i.id))
}

/** The settlement's lines as rows, each tied to the company's own case and invoice where it can be. */
async function settlementLineRows(
  db: SupabaseClient,
  companyId: string,
  settlementId: string,
  settlement: Pick<CollectionsSettlement, 'lines'>,
): Promise<Record<string, unknown>[]> {
  const invoiceRefs = settlement.lines.flatMap((l) => [...(l.invoiceRef ? [l.invoiceRef] : []), ...l.originalInvoiceRefs])
  const own = await ownInvoiceIds(db, companyId, invoiceRefs)
  const caseRefs = [...new Set(settlement.lines.map((l) => l.caseRef).filter((ref): ref is string => !!ref))]
  const { byRef, byInvoice } = await loadCaseIndex(db, companyId, caseRefs, [...own])
  return settlement.lines.map((line, position) => {
    const invoiceId = line.invoiceRef && own.has(line.invoiceRef) ? line.invoiceRef : null
    const byCaseRef = line.caseRef ? byRef.get(line.caseRef) ?? null : null
    const caseId = byCaseRef?.id ?? (invoiceId ? byInvoice.get(invoiceId) ?? null : null)
    return {
      company_id: companyId,
      settlement_id: settlementId,
      position,
      kind: line.kind,
      in_payout: line.inPayout,
      recipient: line.recipient,
      amount: roundOre(line.amount),
      tax_amount: roundOre(line.taxAmount),
      provider_case_ref: line.caseRef ? line.caseRef.slice(0, 128) : null,
      case_id: caseId,
      invoice_id: invoiceId ?? byCaseRef?.invoiceId ?? null,
      original_invoice_ids: [...new Set(line.originalInvoiceRefs.filter((ref) => own.has(ref)))],
      provider_type: line.providerType.slice(0, 128),
      // The provider's free text can name the debtor: never stored.
      description: null,
    }
  })
}

/**
 * Store one settlement and its lines, once. Answers the row id, or null when
 * the company already holds it. A settlement the provider marks as not valid
 * is stored as failed and never booked.
 */
export async function storeSettlement(
  db: SupabaseClient,
  connection: Pick<CollectionConnectionRow, 'id' | 'company_id'>,
  settlement: CollectionsSettlement,
): Promise<string | null> {
  const { data, error } = await db
    .from('collection_settlements')
    .upsert(
      {
        company_id: connection.company_id,
        connection_id: connection.id,
        provider_settlement_ref: settlement.settlementRef.slice(0, 128),
        payment_date: settlement.paymentDate,
        settlement_date: settlement.settlementDate,
        amount: roundOre(settlement.amount),
        currency: settlement.currency,
        provider_status_ok: settlement.statusOk,
        provider_status_code: settlement.statusCode.slice(0, 64),
        bank_reference: settlement.bankReference ? settlement.bankReference.slice(0, 140) : null,
        status: settlement.statusOk ? 'received' : 'failed',
        raw: settlement.raw,
      },
      { onConflict: 'company_id,provider_settlement_ref', ignoreDuplicates: true },
    )
    .select('id')
  if (error) throw new Error(`collection_settlements insert failed: ${error.message}`)
  const id = ((data ?? []) as { id: string }[])[0]?.id ?? null
  if (!id) return null
  try {
    const lines = await settlementLineRows(db, connection.company_id, id, settlement)
    // One object literal per line, so the schema guard checks every column.
    // A line that fails sends the payout to the cleanup below, and its lines
    // go with it (ON DELETE CASCADE): stored whole or not at all, as before.
    for (const line of lines) {
      const { error: linesError } = await db.from('collection_settlement_lines').insert({
        company_id: line.company_id,
        settlement_id: line.settlement_id,
        position: line.position,
        kind: line.kind,
        in_payout: line.in_payout,
        recipient: line.recipient,
        amount: line.amount,
        tax_amount: line.tax_amount,
        provider_case_ref: line.provider_case_ref,
        case_id: line.case_id,
        invoice_id: line.invoice_id,
        original_invoice_ids: line.original_invoice_ids,
        provider_type: line.provider_type,
        description: line.description,
      })
      if (linesError) throw new Error(`collection_settlement_lines insert failed: ${linesError.message}`)
    }
  } catch (error) {
    // A payout without its lines could never be booked, and the next import
    // would skip it as known: remove it so the next import stores it whole.
    const { error: cleanupError } = await db
      .from('collection_settlements')
      .delete()
      .eq('company_id', connection.company_id)
      .eq('id', id)
    if (cleanupError) log.warn('settlement without lines left behind', { settlementId: id, error: cleanupError.message })
    throw error
  }
  return id
}

export interface SettlementImportSummary {
  listed: number
  stored: number
}

/** The day the next payout list starts from: the last payout stored less the overlap, else the first lookback. */
async function importSince(db: SupabaseClient, connection: Pick<CollectionConnectionRow, 'company_id'>, now: Date): Promise<string> {
  const { data, error } = await db
    .from('collection_settlements')
    .select('payment_date')
    .eq('company_id', connection.company_id)
    .order('payment_date', { ascending: false })
    .limit(1)
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  const last = ((data ?? []) as { payment_date: string }[])[0]?.payment_date
  const today = todayIsoStockholm(now)
  return last ? addDays(last, -SETTLEMENT_LIST_OVERLAP_DAYS) : addDays(today, -SETTLEMENT_FIRST_LOOKBACK_DAYS)
}

/** Read the company's payouts from the provider and store the new ones. */
export async function importSettlements(
  deps: SettlementServiceDeps,
  connection: CollectionConnectionRow,
): Promise<SettlementImportSummary> {
  const now = deps.now ? deps.now() : new Date()
  const adapter = adapterForConnection(deps, connection)
  const ctx = callContext(connection.company_id, connection)
  const since = await importSince(deps.db, connection, now)
  const summaries = await adapter.settlements(ctx, { since })
  const summary: SettlementImportSummary = { listed: summaries.length, stored: 0 }
  if (summaries.length === 0) return summary

  const refs = [...new Set(summaries.map((s) => s.settlementRef))]
  const { data, error } = await deps.db
    .from('collection_settlements')
    .select('provider_settlement_ref')
    .eq('company_id', connection.company_id)
    .in('provider_settlement_ref', refs)
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  const known = new Set(((data ?? []) as { provider_settlement_ref: string }[]).map((s) => s.provider_settlement_ref))
  for (const ref of refs) {
    if (known.has(ref)) continue
    const settlement = await adapter.settlement(ctx, { settlementRef: ref })
    if (settlement.settlementRef !== ref) {
      (deps.log ?? log).warn('provider answered another settlement than the one asked for; not stored', { connectionId: connection.id })
      continue
    }
    if (await storeSettlement(deps.db, connection, settlement)) summary.stored++
  }
  return summary
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export type BookSettlementResult =
  | { ok: true; journalEntryId: string; alreadyBooked: boolean; acknowledged: boolean }
  | { ok: false; outcome: 'needs_mapping'; reason: string; issues: SettlementPlanIssue[] }
  | { ok: false; outcome: 'not_found' | 'not_bookable' | 'busy' | 'document_unavailable' }

async function loadSettlement(db: SupabaseClient, companyId: string, id: string): Promise<SettlementRow | null> {
  const { data, error } = await db.from('collection_settlements').select('*').eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  return data ? normalizeSettlementRow(data as Record<string, unknown>) : null
}

export async function loadSettlementLines(db: SupabaseClient, companyId: string, settlementId: string): Promise<SettlementLineRow[]> {
  const { data, error } = await db
    .from('collection_settlement_lines')
    .select('*')
    .eq('company_id', companyId)
    .eq('settlement_id', settlementId)
    .order('position', { ascending: true })
  if (error) throw new Error(`collection_settlement_lines lookup failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeSettlementLineRow)
}

/** The cases each line belongs to: its own, or (merged cases) one per original invoice; empty when any is unknown. */
async function lineCaseIds(db: SupabaseClient, companyId: string, lines: readonly SettlementLineRow[]): Promise<Map<number, string[]>> {
  const originals = [...new Set(lines.flatMap((l) => (l.case_id ? [] : l.original_invoice_ids)))]
  const { byInvoice } = await loadCaseIndex(db, companyId, [], originals)
  const result = new Map<number, string[]>()
  for (const line of lines) {
    if (line.case_id) {
      result.set(line.position, [line.case_id])
      continue
    }
    const cases = line.original_invoice_ids.map((id) => byInvoice.get(id) ?? null)
    result.set(line.position, cases.length > 0 && cases.every((c): c is string => c !== null) ? cases : [])
  }
  return result
}

/** Whether a VAT-registered company (a missing settings row or value counts as registered). */
async function companyVatRegistered(db: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await db.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`company_settings lookup failed: ${error.message}`)
  return (data as { vat_registered?: boolean | null } | null)?.vat_registered !== false
}

async function vatInvoiceAccepted(deps: SettlementServiceDeps, route: CollectionsRoute): Promise<boolean> {
  if (deps.vatInvoiceAccepted !== undefined) return deps.vatInvoiceAccepted
  if (!SETTLEMENT_VAT_INVOICE_ACCEPTED) return false
  const provider = await getCollectionsProvider(route)
  return provider?.features.settlementIsVatInvoice === true
}

/**
 * What the payout's bank row says, to tell it from other bank rows of the
 * same amount: the payout's bank reference when the provider sends one (a
 * KID, Norwegian payouts), else the first word of the provider's name, which
 * a payout without a reference carries as its sender (Swedish payouts; the
 * provider was asked 2026-10-16 what the statement shows). Lowercase; null
 * when neither is known.
 */
async function payoutBankText(
  db: SupabaseClient,
  settlement: Pick<SettlementRow, 'company_id' | 'connection_id' | 'bank_reference'>,
): Promise<string | null> {
  const reference = settlement.bank_reference?.trim().toLowerCase()
  if (reference) return reference
  const { data, error } = await db
    .from('collection_connections')
    .select('display_name')
    .eq('company_id', settlement.company_id)
    .eq('id', settlement.connection_id)
    .maybeSingle()
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  const name = ((data as { display_name: string | null } | null)?.display_name ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
  return name.length >= 4 ? name : null
}

/**
 * A payout already booked by hand: a bank row of the payout's amount and text
 * (payoutBankText) within the window that already sits on a voucher, through
 * its own pointer or through a voucher link (a row bulk-booked into a
 * samlingsverifikat or split over several verifikat carries no pointer, only a
 * 'bank_line' link). Answers that voucher; null when there is no text to look
 * for.
 */
export async function findHandBookedPayout(db: SupabaseClient, settlement: SettlementRow): Promise<string | null> {
  const needle = await payoutBankText(db, settlement)
  if (!needle) return null
  const { data, error } = await db
    .from('transactions')
    .select('id, description, original_description, amount, journal_entry_id, transaction_voucher_links(journal_entry_id, role)')
    .eq('company_id', settlement.company_id)
    .gte('date', addDays(settlement.payment_date, -SETTLEMENT_DUPLICATE_WINDOW_DAYS))
    .lte('date', addDays(settlement.payment_date, SETTLEMENT_DUPLICATE_WINDOW_DAYS))
    .eq('amount', roundOre(settlement.amount))
    .limit(50)
  if (error) throw new Error(`transactions lookup failed: ${error.message}`)
  type Row = {
    description: string | null
    original_description: string | null
    journal_entry_id: string | null
    transaction_voucher_links?: Array<{ journal_entry_id: string; role?: string | null }> | null
  }
  for (const t of (data ?? []) as Row[]) {
    if (!`${t.description ?? ''} ${t.original_description ?? ''}`.toLowerCase().includes(needle)) continue
    const anchor = t.journal_entry_id ?? (t.transaction_voucher_links ?? []).find((l) => (l.role ?? 'bank_line') === 'bank_line')?.journal_entry_id
    if (anchor) return anchor
  }
  return null
}

async function defaultArchiveDocument(db: SupabaseClient, input: { companyId: string; userId: string; document: CollectionsDocument }): Promise<string> {
  const bytes = Buffer.from(input.document.base64, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== input.document.sha256) throw new Error('settlement document does not match its checksum')
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const uploaded = await uploadDocument(
    db,
    input.userId,
    input.companyId,
    { name: input.document.filename, buffer, type: input.document.contentType || 'application/pdf' },
    { upload_source: 'system', extractionOwner: 'none' },
  )
  return uploaded.id
}

/** The posted payout voucher of a settlement, if one exists (a run that died after booking). */
async function findPayoutVoucher(db: SupabaseClient, companyId: string, settlementId: string): Promise<string | null> {
  const { data, error } = await db
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('source_type', 'collection_settlement')
    .eq('source_id', settlementId)
    .eq('status', 'posted')
    .limit(1)
  if (error) throw new Error(`journal_entries lookup failed: ${error.message}`)
  return ((data ?? []) as { id: string }[])[0]?.id ?? null
}

function bookingFailureReason(error: unknown): string | null {
  if (isAccountsNotInChartError(error)) return 'account_not_in_chart'
  const message = error instanceof Error ? error.message : String(error)
  // Whole words: "blocked" (another refusal) is not a locked period.
  if (/\block(ed)?\b|låst|stängd|\bclosed\b/i.test(message)) return 'period_locked'
  if (isBookkeepingError(error)) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code.toLowerCase() : 'booking_failed'
  }
  return null
}

/**
 * Tell the provider a booked payout is in the books (its bookkeep mark).
 * Best-effort: the sync run retries until the provider answers.
 */
export async function acknowledgeSettlement(
  deps: SettlementServiceDeps,
  connection: CollectionConnectionRow,
  settlement: Pick<SettlementRow, 'id' | 'company_id' | 'provider_settlement_ref' | 'journal_entry_id'>,
): Promise<boolean> {
  if (!settlement.journal_entry_id) return false
  const now = deps.now ? deps.now() : new Date()
  try {
    const adapter = adapterForConnection(deps, connection)
    await adapter.markSettlementBooked(callContext(connection.company_id, connection), {
      // Per voucher: a payout booked again after a storno is told again.
      idempotencyKey: `${settlement.id}:${settlement.journal_entry_id}`,
      settlementRef: settlement.provider_settlement_ref,
      internalRef: settlement.journal_entry_id,
    })
  } catch (error) {
    ;(deps.log ?? log).warn('settlement booked mark not accepted yet', {
      settlementId: settlement.id,
      code: isCollectionsError(error) ? error.code : null,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
  const { error } = await deps.db
    .from('collection_settlements')
    .update({ provider_acknowledged_at: now.toISOString() })
    .eq('company_id', settlement.company_id)
    .eq('id', settlement.id)
  if (error) throw new Error(`collection_settlements update failed: ${error.message}`)
  return true
}

/**
 * Book one payout (step D). `actor` is the person who clicked, null for the
 * automatic booking. Safe to call twice: a booked payout answers
 * alreadyBooked, a booking in flight answers busy, and a payout whose
 * voucher exists (a run that died after booking) is finished without a
 * second voucher.
 */
export async function bookSettlement(
  deps: SettlementServiceDeps,
  companyId: string,
  settlementId: string,
  actor: { userId: string } | null,
): Promise<BookSettlementResult> {
  const { db } = deps
  const logger = deps.log ?? log
  const now = deps.now ? deps.now() : new Date()
  const nowIso = now.toISOString()
  const settlement = await loadSettlement(db, companyId, settlementId)
  if (!settlement) return { ok: false, outcome: 'not_found' }
  const connection = await loadConnectionById(db, companyId, settlement.connection_id)
  if (!connection) return { ok: false, outcome: 'not_found' }
  if (settlement.status === 'booked' && settlement.journal_entry_id) {
    const acknowledged = settlement.provider_acknowledged_at ? true : await acknowledgeSettlement(deps, connection, settlement)
    return { ok: true, journalEntryId: settlement.journal_entry_id, alreadyBooked: true, acknowledged }
  }
  if (settlement.status === 'failed' || settlement.status === 'ignored') return { ok: false, outcome: 'not_bookable' }

  const leaseUntil = new Date(now.getTime() + SETTLEMENT_BOOKING_LEASE_MS).toISOString()
  // A free lease was never taken or has run out: two conditional updates with
  // literal filters (the schema guard checks every column), the run-out one
  // only when no never-taken lease was there to claim.
  const claim = (runOut: boolean) => {
    let query = db
      .from('collection_settlements')
      .update({ booking_lease_until: leaseUntil })
      .eq('company_id', companyId)
      .eq('id', settlement.id)
      .in('status', ['received', 'needs_mapping'])
    query = runOut ? query.lt('booking_lease_until', nowIso) : query.is('booking_lease_until', null)
    return query.select('id').maybeSingle()
  }
  let { data: claimed, error: claimError } = await claim(false)
  if (!claimError && !claimed) ({ data: claimed, error: claimError } = await claim(true))
  if (claimError) throw new Error(`collection_settlements claim failed: ${claimError.message}`)
  if (!claimed) return { ok: false, outcome: 'busy' }

  const release = async () => {
    const { error } = await db
      .from('collection_settlements')
      .update({ booking_lease_until: null })
      .eq('company_id', companyId)
      .eq('id', settlement.id)
    if (error) throw new Error(`collection_settlements update failed: ${error.message}`)
  }
  const needsMapping = async (reason: string, issues: SettlementPlanIssue[] = []): Promise<BookSettlementResult> => {
    const { error } = await db
      .from('collection_settlements')
      .update({ status: 'needs_mapping', needs_mapping_reason: reason.slice(0, 200), booking_lease_until: null })
      .eq('company_id', companyId)
      .eq('id', settlement.id)
    if (error) throw new Error(`collection_settlements update failed: ${error.message}`)
    logger.info('settlement needs a person', { settlementId: settlement.id, reason })
    return { ok: false, outcome: 'needs_mapping', reason, issues }
  }

  try {
    const lines = await loadSettlementLines(db, companyId, settlement.id)
    const caseIdsByPosition = await lineCaseIds(db, companyId, lines)
    const caseIds = [...new Set([...caseIdsByPosition.values()].flat())]

    // Step C first: the collected payments of the payout's cases.
    const bookCollected = deps.bookCollected ?? bookCollectedPayment
    if (caseIds.length > 0) {
      const pending = await loadUnbookedCollectedPayments(db, { companyId, caseIds, statuses: ['pending'] })
      for (const payment of pending) {
        await bookCollected({ db, companyId, now: deps.now, log: deps.log, archiveRecord: deps.archiveRecord }, payment.id, actor)
      }
    }
    const plan = await planFor(deps, companyId, settlement, connection, lines, caseIdsByPosition)
    await recordLineAccounts(db, companyId, lines, plan)

    // A run that died after the voucher: finish it, never book twice.
    const existing = await findPayoutVoucher(db, companyId, settlement.id)
    if (existing) {
      await linkDocumentOnce(db, companyId, settlement.document_attachment_id, existing, logger)
      return await finishBooked(deps, connection, settlement, existing, settlement.document_attachment_id, plan, actor, now, true)
    }
    if (!plan.ok) return await needsMapping(plan.reason, plan.issues)

    // A person who confirmed it is not a duplicate is not asked again.
    if (!settlement.duplicate_cleared_at && (await findHandBookedPayout(db, settlement))) return await needsMapping('possible_duplicate')
    const fiscalPeriodId = await findFiscalPeriod(db, companyId, settlement.payment_date)
    if (!fiscalPeriodId) return await needsMapping('no_fiscal_period')

    const userId = actor?.userId ?? connection.user_id ?? connection.consented_by
    let documentId = settlement.document_attachment_id
    if (!documentId) {
      let document: CollectionsDocument
      try {
        document = await adapterForConnection(deps, connection).settlementDocument(callContext(companyId, connection), {
          settlementRef: settlement.provider_settlement_ref,
        })
      } catch (error) {
        if (isCollectionsError(error) && !error.retryable) return await needsMapping('document_unavailable')
        logger.warn('settlement document not available yet', { settlementId: settlement.id, error: error instanceof Error ? error.message : String(error) })
        await release()
        return { ok: false, outcome: 'document_unavailable' }
      }
      documentId = await (deps.archiveDocument ?? ((input) => defaultArchiveDocument(db, input)))({ companyId, userId, document })
      const { error } = await db
        .from('collection_settlements')
        .update({ document_attachment_id: documentId })
        .eq('company_id', companyId)
        .eq('id', settlement.id)
      if (error) throw new Error(`collection_settlements update failed: ${error.message}`)
    }

    let journalEntryId: string
    try {
      // Through the posting port (lib/posting): the engine gets this input
      // unchanged; while POSTING_EVENTS is on, the payout's event is
      // recorded and linked to the draft before a voucher number is drawn.
      const payoutDocumentId = documentId
      const entry = await postingPort.postJournalEntry({
        supabase: db,
        companyId,
        userId,
        event: () => collectionSettlementBusinessEvent(settlement, payoutDocumentId),
        input: {
          fiscal_period_id: fiscalPeriodId,
          entry_date: settlement.payment_date,
          description: `Utbetalning från ${connection.display_name || 'inkassobolaget'}${settlement.bank_reference ? ` ${settlement.bank_reference}` : ''}`.slice(0, 200),
          source_type: 'collection_settlement',
          source_id: settlement.id,
          lines: plan.lines,
        },
      })
      journalEntryId = entry.id
    } catch (error) {
      // Another booking won the one live payout voucher.
      const raced = await findPayoutVoucher(db, companyId, settlement.id)
      if (raced) {
        await linkDocumentOnce(db, companyId, documentId, raced, logger)
        return await finishBooked(deps, connection, settlement, raced, documentId, plan, actor, now, true)
      }
      const reason = bookingFailureReason(error)
      if (reason) return await needsMapping(reason)
      throw error
    }
    await linkDocumentOnce(db, companyId, documentId, journalEntryId, logger)
    return await finishBooked(deps, connection, settlement, journalEntryId, documentId, plan, actor, now, false)
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
}

/**
 * The planner's answer for a payout: its lines, their cases, the cases'
 * collected payments, the connection's accounts and the VAT rules. The one
 * place both the booking and the read-only preview build it, so a preview
 * shows the voucher the booking posts. `simulate` is the preview's: pending
 * collected payments count as booked (the booking books them first) and a
 * person's account choices apply without being written.
 */
async function planFor(
  deps: Pick<SettlementServiceDeps, 'db' | 'vatInvoiceAccepted'>,
  companyId: string,
  settlement: SettlementRow,
  connection: CollectionConnectionRow,
  lines: readonly SettlementLineRow[],
  caseIdsByPosition: ReadonlyMap<number, string[]>,
  simulate?: { choices: readonly SettlementPreviewChoice[] },
): Promise<SettlementPlan> {
  const { db } = deps
  const caseIds = [...new Set([...caseIdsByPosition.values()].flat())]
  const loaded = caseIds.length === 0 ? [] : await loadCollectedForCases(db, companyId, caseIds)
  const collected = simulate ? loaded.map((p) => (p.status === 'pending' ? { ...p, status: 'booked' as const } : p)) : loaded
  const chosenFor = (line: SettlementLineRow): SettlementLineInput['chosen'] => {
    const choice = simulate?.choices.find((c) => c.position === line.position)
    if (choice) return { account: choice.accountNumber ?? line.account_number, vatAccount: choice.vatAccountNumber ?? line.vat_account_number }
    return line.account_chosen_by ? { account: line.account_number, vatAccount: line.vat_account_number } : null
  }
  return planSettlementVoucher({
    settlementId: settlement.id,
    amount: settlement.amount,
    currency: settlement.currency,
    paymentDate: settlement.payment_date,
    providerStatusOk: settlement.provider_status_ok,
    lines: lines.map((line): SettlementLineInput => ({
      position: line.position,
      kind: line.kind,
      inPayout: line.in_payout,
      recipient: line.recipient,
      amount: line.amount,
      taxAmount: line.tax_amount,
      caseIds: caseIdsByPosition.get(line.position) ?? [],
      chosen: chosenFor(line),
    })),
    collected: collected.map((p) => ({
      id: p.id,
      caseId: p.case_id,
      status: p.status,
      capitalPaid: p.capital_paid,
      paidAt: p.paid_at,
      settlementId: p.settlement_id,
    })),
    clearingAccount: connection.clearing_account,
    payoutAccount: connection.payout_account,
    vatRegistered: await companyVatRegistered(db, companyId),
    vatInvoiceAccepted: await vatInvoiceAccepted(deps, connection.route),
  })
}

/** A person's (or a staged booking's) account for a payout line, as the preview applies it. */
export interface SettlementPreviewChoice {
  position: number
  accountNumber?: string
  vatAccountNumber?: string
}

/**
 * The voucher booking this payout would post now, read only: nothing is
 * written, claimed or booked. Pending collected payments of its cases count
 * as booked (the booking books them first) and the given account choices
 * apply as if recorded. Null when the payout or its connection is not found.
 */
export async function previewSettlementVoucher(
  deps: Pick<SettlementServiceDeps, 'db' | 'vatInvoiceAccepted'>,
  companyId: string,
  settlementId: string,
  choices: readonly SettlementPreviewChoice[] = [],
): Promise<SettlementPlan | null> {
  const settlement = await loadSettlement(deps.db, companyId, settlementId)
  if (!settlement) return null
  const connection = await loadConnectionById(deps.db, companyId, settlement.connection_id)
  if (!connection) return null
  const lines = await loadSettlementLines(deps.db, companyId, settlement.id)
  const caseIdsByPosition = await lineCaseIds(deps.db, companyId, lines)
  return planFor(deps, companyId, settlement, connection, lines, caseIdsByPosition, { choices })
}

/**
 * The collected payments of the payout's cases. A payment counts as booked
 * only while its C voucher is posted: a rebook that died between its storno
 * and its release leaves the payment marked booked on a reversed voucher, and
 * a payout must never clear the capital of a voucher the books no longer
 * hold (the clearing account would go short). Such a payment reads as
 * waiting for a person until the rebook is finished.
 */
async function loadCollectedForCases(db: SupabaseClient, companyId: string, caseIds: readonly string[]) {
  const { data, error } = await db
    .from('collection_collected_payments')
    .select('*')
    .eq('company_id', companyId)
    .in('case_id', [...caseIds])
  if (error) throw new Error(`collection_collected_payments lookup failed: ${error.message}`)
  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeCollectedPaymentRow)
  const voucherIds = [...new Set(rows.filter((r) => r.status === 'booked' && r.journal_entry_id).map((r) => r.journal_entry_id as string))]
  if (voucherIds.length === 0) return rows
  const { data: vouchers, error: vouchersError } = await db
    .from('journal_entries')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', voucherIds)
  if (vouchersError) throw new Error(`journal_entries lookup failed: ${vouchersError.message}`)
  const notPosted = new Set(
    ((vouchers ?? []) as { id: string; status: string | null }[]).filter((v) => v.status !== 'posted').map((v) => v.id),
  )
  return rows.map((r) => (r.status === 'booked' && r.journal_entry_id && notPosted.has(r.journal_entry_id) ? { ...r, status: 'needs_review' as const } : r))
}

/** Write the accounts the plan resolved onto lines no person chose for. */
async function recordLineAccounts(db: SupabaseClient, companyId: string, lines: readonly SettlementLineRow[], plan: SettlementPlan): Promise<void> {
  for (const accounts of plan.lineAccounts) {
    const line = lines.find((l) => l.position === accounts.position)
    if (!line || line.account_chosen_by) continue
    if (line.account_number === accounts.account && line.vat_account_number === accounts.vatAccount) continue
    const { error } = await db
      .from('collection_settlement_lines')
      .update({ account_number: accounts.account, vat_account_number: accounts.vatAccount })
      .eq('company_id', companyId)
      .eq('id', line.id)
    if (error) throw new Error(`collection_settlement_lines update failed: ${error.message}`)
  }
}

export type PayoutBankLinkOutcome = 'linked' | 'already_linked' | 'not_found' | 'ambiguous' | 'refused'

/**
 * Link the payout's bank row to the booked payout voucher (build spec 4.4):
 * the one unbooked bank row of the payout's amount, within
 * SETTLEMENT_BANK_LINK_WINDOW_DAYS of the payout day, whose text carries the
 * payout's bank reference, or the provider's name when the payout has no
 * reference (payoutBankText). It goes through the existing link path
 * (linkTransactionToJournalEntry), which books nothing new and clears the
 * row's potential_invoice_id hint, so the payout is never matched to an open
 * invoice. Best-effort: the payout stays booked whatever happens here, two
 * candidate rows are left to a person, and a row not in the bank feed yet is
 * looked for again by the sync run.
 */
/**
 * The candidate bank rows on the bank account the payout voucher debits: a
 * row of another bank account (its cash account books to another 19xx
 * account) never explains this voucher, and linking it would show that
 * account's row as booked while its ledger never got the money. A row with no
 * cash account (older imports) stays a candidate; with no payout line found
 * on the voucher, only those do.
 */
async function onPayoutAccount<T extends { cash_account_id?: string | null }>(
  db: SupabaseClient,
  companyId: string,
  journalEntryId: string,
  rows: readonly T[],
): Promise<T[]> {
  const cashAccountIds = [...new Set(rows.map((r) => r.cash_account_id).filter((id): id is string => !!id))]
  if (cashAccountIds.length === 0) return [...rows]
  const { data: lines, error: linesError } = await db
    .from('journal_entry_lines')
    .select('account_number, debit_amount')
    .eq('journal_entry_id', journalEntryId)
  if (linesError) throw new Error(`journal_entry_lines lookup failed: ${linesError.message}`)
  const payoutAccount =
    ((lines ?? []) as { account_number: string; debit_amount: number | string | null }[]).find(
      (l) => l.account_number.startsWith('19') && Number(l.debit_amount ?? 0) > 0,
    )?.account_number ?? null
  const { data: accounts, error: accountsError } = await db
    .from('cash_accounts')
    .select('id, ledger_account')
    .eq('company_id', companyId)
    .in('id', cashAccountIds)
  if (accountsError) throw new Error(`cash_accounts lookup failed: ${accountsError.message}`)
  const ledgerOf = new Map(((accounts ?? []) as { id: string; ledger_account: string | null }[]).map((a) => [a.id, a.ledger_account]))
  return rows.filter((r) => !r.cash_account_id || (payoutAccount !== null && ledgerOf.get(r.cash_account_id) === payoutAccount))
}

export async function linkPayoutBankRow(
  deps: SettlementServiceDeps,
  settlement: Pick<
    SettlementRow,
    'id' | 'company_id' | 'connection_id' | 'amount' | 'payment_date' | 'bank_reference' | 'journal_entry_id' | 'bank_transaction_id'
  >,
  userId: string,
): Promise<PayoutBankLinkOutcome> {
  const logger = deps.log ?? log
  if (settlement.bank_transaction_id) return 'already_linked'
  if (!settlement.journal_entry_id) return 'not_found'
  try {
    const reference = await payoutBankText(deps.db, settlement)
    if (!reference) return 'not_found'
    const { data, error } = await deps.db
      .from('open_bank_rows')
      .select('id, description, original_description, cash_account_id')
      .eq('company_id', settlement.company_id)
      .gte('date', addDays(settlement.payment_date, -SETTLEMENT_BANK_LINK_WINDOW_DAYS))
      .lte('date', addDays(settlement.payment_date, SETTLEMENT_BANK_LINK_WINDOW_DAYS))
      .eq('amount', roundOre(settlement.amount))
      .limit(20)
    if (error) throw new Error(`transactions lookup failed: ${error.message}`)
    const referenced = ((data ?? []) as { id: string; description: string | null; original_description: string | null; cash_account_id?: string | null }[]).filter(
      (t) => `${t.description ?? ''} ${t.original_description ?? ''}`.toLowerCase().includes(reference),
    )
    const candidates = await onPayoutAccount(deps.db, settlement.company_id, settlement.journal_entry_id, referenced)
    if (candidates.length === 0) return 'not_found'
    if (candidates.length > 1) {
      logger.info('payout bank row is ambiguous; left to a person', { settlementId: settlement.id, candidates: candidates.length })
      return 'ambiguous'
    }
    const link = deps.linkBankRow ?? linkTransactionToJournalEntry
    const result = await link(deps.db, userId, settlement.company_id, {
      transactionId: candidates[0]!.id,
      journalEntryId: settlement.journal_entry_id,
    })
    if (!result.ok) {
      logger.info('payout bank row not linked', { settlementId: settlement.id, code: result.code })
      return 'refused'
    }
    const { error: updateError } = await deps.db
      .from('collection_settlements')
      .update({ bank_transaction_id: candidates[0]!.id })
      .eq('company_id', settlement.company_id)
      .eq('id', settlement.id)
      .eq('journal_entry_id', settlement.journal_entry_id)
    if (updateError) throw new Error(`collection_settlements update failed: ${updateError.message}`)
    logger.info('payout bank row linked to the payout voucher', { settlementId: settlement.id, transactionId: candidates[0]!.id })
    return 'linked'
  } catch (err) {
    logger.warn('payout bank row linking failed', { settlementId: settlement.id, error: err instanceof Error ? err.message : String(err) })
    return 'refused'
  }
}

/**
 * The settlement PDF is underlag of every C voucher it settles too (build
 * spec 4.2 D): a document row links to one voucher, so each C voucher gets
 * its own archived copy. Idempotent (copyDocumentToVoucher's id is
 * deterministic per settlement, voucher and content).
 */
async function copySettlementDocumentToCollected(
  deps: SettlementServiceDeps,
  connection: CollectionConnectionRow,
  settlement: SettlementRow,
  documentId: string | null,
  plan: SettlementPlan,
  actor: { userId: string } | null,
): Promise<number> {
  if (!documentId) return 0
  const { db } = deps
  const companyId = settlement.company_id
  const ids = plan.ok ? plan.settles : []
  const rows: { journal_entry_id: string | null }[] = []
  if (ids.length > 0) {
    const { data, error } = await db
      .from('collection_collected_payments')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .in('id', [...ids])
    if (error) throw new Error(`collection_collected_payments lookup failed: ${error.message}`)
    rows.push(...((data ?? []) as { journal_entry_id: string | null }[]))
  }
  const { data: tied, error: tiedError } = await db
    .from('collection_collected_payments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('settlement_id', settlement.id)
  if (tiedError) throw new Error(`collection_collected_payments lookup failed: ${tiedError.message}`)
  rows.push(...((tied ?? []) as { journal_entry_id: string | null }[]))

  const vouchers = [...new Set(rows.map((r) => r.journal_entry_id).filter((id): id is string => !!id))]
  const copy = deps.copyDocument ?? ((input: CopyDocumentInput) => copyDocumentToVoucher(db, input))
  const userId = actor?.userId ?? connection.user_id ?? connection.consented_by
  for (const journalEntryId of vouchers) {
    await copy({ companyId, userId, documentId, journalEntryId, scope: `collection-settlement:${settlement.id}` })
  }
  return vouchers.length
}

async function finishBooked(
  deps: SettlementServiceDeps,
  connection: CollectionConnectionRow,
  settlement: SettlementRow,
  journalEntryId: string,
  documentId: string | null,
  plan: SettlementPlan,
  actor: { userId: string } | null,
  now: Date,
  alreadyBooked: boolean,
): Promise<BookSettlementResult> {
  const { db } = deps
  const companyId = settlement.company_id
  // Before the booked mark, so a run that dies here finishes the copies on the next attempt.
  await copySettlementDocumentToCollected(deps, connection, settlement, documentId, plan, actor)
  const { error } = await db
    .from('collection_settlements')
    .update({
      status: 'booked',
      journal_entry_id: journalEntryId,
      booked_at: now.toISOString(),
      booked_by: actor?.userId ?? null,
      needs_mapping_reason: null,
      booking_lease_until: null,
    })
    .eq('company_id', companyId)
    .eq('id', settlement.id)
  if (error) throw new Error(`collection_settlements update failed: ${error.message}`)

  const bookedPositions = plan.lineAccounts.filter((l) => l.booked).map((l) => l.position)
  if (bookedPositions.length > 0) {
    const { error: linesError } = await db
      .from('collection_settlement_lines')
      .update({ booked: true })
      .eq('company_id', companyId)
      .eq('settlement_id', settlement.id)
      .in('position', bookedPositions)
    if (linesError) throw new Error(`collection_settlement_lines update failed: ${linesError.message}`)
  }
  if (plan.ok && plan.settles.length > 0) {
    const { error: settlesError } = await db
      .from('collection_collected_payments')
      .update({ settlement_id: settlement.id })
      .eq('company_id', companyId)
      .in('id', plan.settles)
    if (settlesError) throw new Error(`collection_collected_payments update failed: ${settlesError.message}`)
  } else if (!plan.ok) {
    ;(deps.log ?? log).warn('payout voucher found without a plan; its collected payments are not tied to it', { settlementId: settlement.id })
  }
  ;(deps.log ?? log).info('settlement booked', { settlementId: settlement.id, journalEntryId, alreadyBooked })
  await linkPayoutBankRow(deps, { ...settlement, journal_entry_id: journalEntryId }, actor?.userId ?? connection.user_id ?? connection.consented_by)
  const acknowledged = await acknowledgeSettlement(deps, connection, { ...settlement, journal_entry_id: journalEntryId })
  return { ok: true, journalEntryId, alreadyBooked, acknowledged }
}

// ---------------------------------------------------------------------------
// A way out of possible_duplicate
// ---------------------------------------------------------------------------

export const SETTLEMENT_IGNORED_REASON_MAX = 500

export type ResolveDuplicateResult =
  | { ok: true; resolution: 'not_duplicate'; booking: BookSettlementResult }
  | { ok: true; resolution: 'handled_elsewhere' }
  | { ok: false; outcome: 'not_found' | 'not_possible_duplicate' | 'busy' | 'invalid_reason' }

/** Why a waiting payout may be marked as handled elsewhere: booked by hand already, or a claim the books do not know (one handed to the provider outside Accounted). */
const HANDLED_ELSEWHERE_REASONS: ReadonlySet<string> = new Set(['possible_duplicate', 'unknown_case'])

/**
 * A person's answer to a payout held as a possible duplicate (a bank row of
 * its amount and reference already sits on a voucher booked by hand), or to
 * one with a line for a claim the books do not know:
 *
 *   not_duplicate      the payout is booked, and the guard does not ask again
 *                      (possible duplicates only);
 *   handled_elsewhere  the payout is marked ignored with the person's reason
 *                      and never booked.
 *
 * Only for a payout in needs_mapping with one of those reasons and no
 * booking in flight. The database writes both decisions to audit_log with
 * the person (audit_collection_settlement_decision).
 */
export async function resolvePossibleDuplicate(
  deps: SettlementServiceDeps,
  companyId: string,
  settlementId: string,
  actor: { userId: string },
  decision: { resolution: 'not_duplicate' } | { resolution: 'handled_elsewhere'; reason: string },
): Promise<ResolveDuplicateResult> {
  const { db } = deps
  const now = deps.now ? deps.now() : new Date()
  const nowIso = now.toISOString()
  const settlement = await loadSettlement(db, companyId, settlementId)
  if (!settlement) return { ok: false, outcome: 'not_found' }
  const waitingReason = settlement.status === 'needs_mapping' ? settlement.needs_mapping_reason : null
  const allowed =
    decision.resolution === 'not_duplicate'
      ? waitingReason === 'possible_duplicate'
      : waitingReason !== null && HANDLED_ELSEWHERE_REASONS.has(waitingReason)
  if (!allowed || waitingReason === null) {
    return { ok: false, outcome: 'not_possible_duplicate' }
  }

  const reason = decision.resolution === 'handled_elsewhere' ? decision.reason.trim() : null
  if (decision.resolution === 'handled_elsewhere' && (!reason || reason.length > SETTLEMENT_IGNORED_REASON_MAX)) {
    return { ok: false, outcome: 'invalid_reason' }
  }
  const settlements = db.from('collection_settlements')
  const updated =
    decision.resolution === 'not_duplicate'
      ? settlements.update({ duplicate_cleared_by: actor.userId, duplicate_cleared_at: nowIso })
      : settlements.update({ status: 'ignored', ignored_reason: reason, ignored_by: actor.userId, ignored_at: nowIso, booking_lease_until: null })
  const { data, error } = await updated
    .eq('company_id', companyId)
    .eq('id', settlement.id)
    .eq('status', 'needs_mapping')
    .eq('needs_mapping_reason', waitingReason)
    .or(`booking_lease_until.is.null,booking_lease_until.lt.${nowIso}`)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`collection_settlements update failed: ${error.message}`)
  if (!data) return { ok: false, outcome: 'busy' }
  ;(deps.log ?? log).info('possible duplicate payout resolved', { settlementId: settlement.id, resolution: decision.resolution })

  if (decision.resolution === 'handled_elsewhere') return { ok: true, resolution: 'handled_elsewhere' }
  return { ok: true, resolution: 'not_duplicate', booking: await bookSettlement(deps, companyId, settlement.id, actor) }
}

// ---------------------------------------------------------------------------
// The sync run's share
// ---------------------------------------------------------------------------

export interface SettlementSyncSummary {
  imported: number
  booked: number
  needsMapping: number
  acknowledged: number
  /** Booked payouts whose bank row was linked to the payout voucher in this run. */
  bankLinked: number
  failed: number
  /** Steps left for the next run because the run budget was spent. */
  deferred: number
}

/** Connections whose payouts are still read: every connection with a handle that is not ended, or ended in the last half year. */
async function settlementConnections(db: SupabaseClient, now: Date): Promise<CollectionConnectionRow[]> {
  const endedSince = new Date(now.getTime() - 183 * 86_400_000).toISOString()
  // Not ended, then ended since: two reads with literal filters, so the
  // schema guard checks every column.
  const limit = 500
  const { data: live, error } = await db
    .from('collection_connections')
    .select('*')
    .not('connection_handle', 'is', null)
    .is('ended_at', null)
    .limit(limit)
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  const found = [...((live ?? []) as Record<string, unknown>[])]
  if (found.length < limit) {
    const { data: ended, error: endedError } = await db
      .from('collection_connections')
      .select('*')
      .not('connection_handle', 'is', null)
      .gt('ended_at', endedSince)
      .limit(limit - found.length)
    if (endedError) throw new Error(`collection_connections lookup failed: ${endedError.message}`)
    found.push(...((ended ?? []) as Record<string, unknown>[]))
  }
  return found.map(normalizeConnectionRow)
}

/**
 * The settlement work of a sync run. Every run: payouts booked but not yet
 * acknowledged are told to the provider again, and booked payouts whose bank
 * row has not been found are looked for again (SETTLEMENT_BANK_LINK_RETRY_DAYS).
 * Once a night (`importAll`): every connection's payouts are imported, and
 * the companies that turned on auto_book_settlements get their new payouts
 * booked. A failing connection never stops the rest. A dark installation (no
 * connection) makes no call. Nothing new starts once `budgetMs` (the sync
 * run's time left) is spent: what is left counts as deferred and waits for
 * the next run (an import the next night: it starts from the last payout
 * stored, so nothing is lost).
 */
export async function runSettlementSync(
  deps: SettlementServiceDeps,
  options: { importAll: boolean; budgetMs?: number; clock?: () => number },
): Promise<SettlementSyncSummary> {
  const summary: SettlementSyncSummary = { imported: 0, booked: 0, needsMapping: 0, acknowledged: 0, bankLinked: 0, failed: 0, deferred: 0 }
  const logger = deps.log ?? log
  const now = deps.now ? deps.now() : new Date()
  const clock = options.clock ?? Date.now
  const started = clock()
  const budget = options.budgetMs ?? Number.POSITIVE_INFINITY
  const hasTime = () => clock() - started < budget

  const { data: unacknowledged, error } = await deps.db
    .from('collection_settlements')
    .select('*')
    .eq('status', 'booked')
    .is('provider_acknowledged_at', null)
    .limit(20)
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  for (const raw of (unacknowledged ?? []) as Record<string, unknown>[]) {
    if (!hasTime()) {
      summary.deferred++
      continue
    }
    const settlement = normalizeSettlementRow(raw)
    const connection = await loadConnectionById(deps.db, settlement.company_id, settlement.connection_id)
    if (connection && (await acknowledgeSettlement(deps, connection, settlement))) summary.acknowledged++
  }

  // A payout booked before its bank row reached the bank feed: look for the row again.
  const { data: unlinked, error: unlinkedError } = await deps.db
    .from('collection_settlements')
    .select('*')
    .eq('status', 'booked')
    .is('bank_transaction_id', null)
    .gte('payment_date', addDays(todayIsoStockholm(now), -SETTLEMENT_BANK_LINK_RETRY_DAYS))
    .limit(20)
  if (unlinkedError) throw new Error(`collection_settlements lookup failed: ${unlinkedError.message}`)
  for (const raw of (unlinked ?? []) as Record<string, unknown>[]) {
    if (!hasTime()) {
      summary.deferred++
      continue
    }
    const settlement = normalizeSettlementRow(raw)
    const connection = await loadConnectionById(deps.db, settlement.company_id, settlement.connection_id)
    if (!connection) continue
    const userId = settlement.booked_by ?? connection.user_id ?? connection.consented_by
    if ((await linkPayoutBankRow(deps, settlement, userId)) === 'linked') summary.bankLinked++
  }

  if (!options.importAll) return summary
  for (const connection of await settlementConnections(deps.db, now)) {
    if (!hasTime()) {
      summary.deferred++
      continue
    }
    try {
      summary.imported += (await importSettlements(deps, connection)).stored
    } catch (err) {
      summary.failed++
      logger.warn('settlement import failed', { connectionId: connection.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!connection.auto_book_settlements) continue
    const { data: received, error: receivedError } = await deps.db
      .from('collection_settlements')
      .select('id')
      .eq('company_id', connection.company_id)
      .eq('status', 'received')
      .order('payment_date', { ascending: true })
      .limit(20)
    if (receivedError) throw new Error(`collection_settlements lookup failed: ${receivedError.message}`)
    for (const { id } of (received ?? []) as { id: string }[]) {
      if (!hasTime()) {
        summary.deferred++
        continue
      }
      try {
        const result = await bookSettlement(deps, connection.company_id, id, null)
        if (result.ok) summary.booked++
        else if (result.outcome === 'needs_mapping') summary.needsMapping++
      } catch (err) {
        summary.failed++
        logger.warn('automatic settlement booking failed', { settlementId: id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  if (summary.deferred > 0) logger.info('settlement work deferred to the next run: the run budget is spent', { deferred: summary.deferred })
  return summary
}
