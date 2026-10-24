import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { escapeLikePattern } from '@/lib/supabase/like-pattern'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/bookkeeping/matchable-statuses'
import {
  closedLookupNumbers,
  resolvePastedReferences,
  type PasteInvoice,
  type PasteInvoiceState,
  type PastedReference,
} from './invoice-number-paste'

/**
 * Open customer and supplier invoices for the surfaces that match a bank
 * transaction to one: the invoice picker (components/transactions/
 * InvoicePicker, both directions) and the batch allocation dialog
 * (MatchAllocationDialog). loadOpenInvoicesForMatch is the one loader they
 * share.
 *
 * The pickers used to load the newest PICKER_LIMIT open invoices and filter
 * them in the browser, so a search could never find an older open invoice: it
 * was simply not in the list. A search term now goes to the database, which
 * matches the invoice number or the counterparty name across every open
 * invoice; without a term the newest PICKER_LIMIT still make the default view.
 *
 * The statuses are the ones the match routes and the batch RPC accept
 * (lib/bookkeeping/matchable-statuses): offering anything else gives a confirm
 * that can only fail, and hiding one of them hides a match the server takes.
 */

/** Rows one picker request returns, with or without a search term. */
export const PICKER_LIMIT = 200

/** ILIKE pattern for a picker search term, or null for a blank term. */
export function pickerSearchPattern(term: string): string | null {
  const trimmed = term.trim()
  return trimmed ? `%${escapeLikePattern(trimmed)}%` : null
}

interface PickerRow {
  id: string
  invoice_date: string | null
}

/** Newest first, id as the tiebreak, at most PICKER_LIMIT, each row once. */
function mergeNewestFirst<T extends PickerRow>(lists: T[][]): T[] {
  const byId = new Map<string, T>()
  for (const list of lists) {
    for (const row of list) if (!byId.has(row.id)) byId.set(row.id, row)
  }
  return [...byId.values()]
    .sort((a, b) => {
      const dateA = a.invoice_date ?? ''
      const dateB = b.invoice_date ?? ''
      if (dateA !== dateB) return dateA < dateB ? 1 : -1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, PICKER_LIMIT)
}

async function rowsOf<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data as T[] | null) ?? []
}

/**
 * Open customer invoices a bank receipt can be matched to: real invoices
 * (no proformas, no credit notes), not yet fully settled.
 */
export async function searchOpenInvoices<T extends PickerRow>(
  supabase: SupabaseDataClient,
  companyId: string,
  term: string,
): Promise<T[]> {
  // Filter out fully-settled invoices defensively: match-invoice should flip
  // status to 'paid' on full settlement, but a stale 'sent'/'overdue' row with
  // remaining_amount=0 would otherwise be selectable and could be matched a
  // second time, double-booking the income. Proformas (PF- series) are not a
  // faktura per ML 17 kap 24 § and must never be matched against a receipt.
  // Literal select strings throughout: the schema guard checks their columns.
  const pattern = pickerSearchPattern(term)
  let byNumberQuery = supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('company_id', companyId)
    .eq('document_type', 'invoice')
    .is('credited_invoice_id', null)
    .in('status', [...MATCHABLE_INVOICE_STATUSES])
    .gt('remaining_amount', 0)
  if (pattern) byNumberQuery = byNumberQuery.ilike('invoice_number', pattern)
  const byNumber = rowsOf<T>(
    byNumberQuery
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  if (!pattern) return byNumber

  const byCustomer = rowsOf<T>(
    supabase
      .from('invoices')
      .select('*, customer:customers!inner(*)')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .is('credited_invoice_id', null)
      .in('status', [...MATCHABLE_INVOICE_STATUSES])
      .gt('remaining_amount', 0)
      .ilike('customer.name', pattern)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  return mergeNewestFirst(await Promise.all([byNumber, byCustomer]))
}

/**
 * Open supplier invoices a bank payment can be matched to: not yet fully
 * settled, in a status match-supplier-invoice and the batch RPC accept
 * (registered ones included: both take a payment before attest).
 */
export async function searchOpenSupplierInvoices<T extends PickerRow>(
  supabase: SupabaseDataClient,
  companyId: string,
  term: string,
): Promise<T[]> {
  // The statuses match-supplier-invoice takes a payment in
  // (MATCHABLE_SUPPLIER_INVOICE_STATUSES); paid/credited/reversed are terminal.
  const pattern = pickerSearchPattern(term)
  let byNumberQuery = supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*)')
    .eq('company_id', companyId)
    .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
    .gt('remaining_amount', 0)
  if (pattern) byNumberQuery = byNumberQuery.ilike('supplier_invoice_number', pattern)
  const byNumber = rowsOf<T>(
    byNumberQuery
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  if (!pattern) return byNumber

  const bySupplier = rowsOf<T>(
    supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers!inner(*)')
      .eq('company_id', companyId)
      .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
      .gt('remaining_amount', 0)
      .ilike('supplier.name', pattern)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  return mergeNewestFirst(await Promise.all([byNumber, bySupplier]))
}

export type OpenInvoiceKind = 'customer' | 'supplier'

interface MatchRow extends PickerRow {
  status: string
}

export interface OpenInvoicesForMatch<T> {
  rows: T[]
  /** The request came back full: older rows exist past PICKER_LIMIT. */
  capped: boolean
}

/**
 * The open invoices of one direction a bank transaction can be matched to,
 * for a search term ('' for the newest), with the status-leak guard applied:
 * a row whose status still says it is unpaid ('sent'/'overdue', or
 * 'registered'/'approved'/'overdue' for a supplier invoice) but that already
 * has a payment voucher is hidden, since the status was never moved on.
 * Partially paid rows pass: they may take more payments. Mirrors the
 * server-side filter the automatic matcher applies (findMatchingInvoices in
 * lib/invoices/invoice-matching).
 */
export async function loadOpenInvoicesForMatch<T extends MatchRow>(
  supabase: SupabaseDataClient,
  companyId: string,
  kind: OpenInvoiceKind,
  term: string,
): Promise<OpenInvoicesForMatch<T>> {
  const all =
    kind === 'customer'
      ? await searchOpenInvoices<T>(supabase, companyId, term)
      : await searchOpenSupplierInvoices<T>(supabase, companyId, term)
  const fullIds = all.filter((inv) => inv.status !== 'partially_paid').map((inv) => inv.id)
  if (fullIds.length === 0) return { rows: all, capped: all.length >= PICKER_LIMIT }
  const paid = await idsWithPaymentVoucher(supabase, companyId, kind, fullIds)
  return { rows: all.filter((inv) => !paid.has(inv.id)), capped: all.length >= PICKER_LIMIT }
}

/**
 * Ids or numbers per `.in()` read. They travel in the GET query string, and a
 * gateway with the stock 8 KB header buffer answers a long one with 414
 * before PostgREST sees it (#2395): 100 uuids are about 3.7 KB. The same
 * bound as ID_READ_CHUNK in lib/reconciliation/limits.
 */
const IN_READ_CHUNK = 100

/**
 * The status-leak guard: which of these invoices, though their status says
 * unpaid, already have a payment voucher. Read in slices, so a long list
 * never becomes one oversized query string.
 */
async function idsWithPaymentVoucher(
  supabase: SupabaseDataClient,
  companyId: string,
  kind: OpenInvoiceKind,
  ids: readonly string[],
): Promise<Set<string>> {
  const paid = new Set<string>()
  for (const slice of chunk(ids, IN_READ_CHUNK)) {
    // Literal select strings, one per table: the schema guard checks their columns.
    const found =
      kind === 'customer'
        ? (
            await rowsOf<{ invoice_id: string }>(
              supabase
                .from('invoice_payments')
                .select('invoice_id')
                .eq('company_id', companyId)
                .in('invoice_id', slice)
                .not('journal_entry_id', 'is', null),
            )
          ).map((r) => r.invoice_id)
        : (
            await rowsOf<{ supplier_invoice_id: string }>(
              supabase
                .from('supplier_invoice_payments')
                .select('supplier_invoice_id')
                .eq('company_id', companyId)
                .in('supplier_invoice_id', slice)
                .not('journal_entry_id', 'is', null),
            )
          ).map((r) => r.supplier_invoice_id)
    for (const id of found) paid.add(id)
  }
  return paid
}

/** An invoice a pasted list of numbers can name, with what the batch dialog shows of it. */
export interface PasteLookupInvoice extends PasteInvoice {
  /** The number shown in the dialog (a supplier invoice without one shows its LF arrival number). */
  label: string
  counterpartyName: string | null
  status: string
  total: number
  exchangeRate: number | null
  dueDate: string
  invoiceDate: string | null
}

export interface InvoicesForPaste {
  invoices: PasteLookupInvoice[]
  /** The company has more open invoices than one paste reads: some may be missing. */
  capped: boolean
}

/** Open invoices one paste reads: far above any company's open ledger, a bound on a runaway read. */
export const PASTE_OPEN_INVOICES_MAX = 20_000

interface CustomerPasteRow {
  id: string
  invoice_number: string | null
  status: string
  total: number | null
  remaining_amount: number | null
  currency: string | null
  exchange_rate: number | null
  due_date: string | null
  invoice_date: string | null
  customer: { name: string | null } | null
}

interface SupplierPasteRow {
  id: string
  supplier_invoice_number: string | null
  payment_reference: string | null
  arrival_number: number | null
  status: string
  total: number | null
  remaining_amount: number | null
  currency: string | null
  exchange_rate: number | null
  due_date: string | null
  invoice_date: string | null
  supplier: { name: string | null } | null
}

/** A row outside the open set: paid when its money is in, otherwise not open (draft, credited, cancelled, proforma). */
function closedState(row: { status: string; remaining_amount: number | null }): PasteInvoiceState {
  return row.status === 'paid' || Number(row.remaining_amount ?? 0) <= 0 ? 'paid' : 'not_open'
}

function customerPasteInvoice(row: CustomerPasteRow, state: PasteInvoiceState): PasteLookupInvoice {
  return {
    id: row.id,
    number: row.invoice_number,
    state,
    currency: row.currency,
    remaining: Number(row.remaining_amount ?? row.total ?? 0),
    label: row.invoice_number ?? row.id.slice(0, 8),
    counterpartyName: row.customer?.name ?? null,
    status: row.status,
    total: Number(row.total ?? 0),
    exchangeRate: row.exchange_rate != null ? Number(row.exchange_rate) : null,
    dueDate: row.due_date ?? '',
    invoiceDate: row.invoice_date,
  }
}

function supplierPasteInvoice(row: SupplierPasteRow, state: PasteInvoiceState): PasteLookupInvoice {
  return {
    id: row.id,
    number: row.supplier_invoice_number,
    paymentReference: row.payment_reference,
    state,
    currency: row.currency,
    remaining: Number(row.remaining_amount ?? row.total ?? 0),
    label: row.supplier_invoice_number ?? `LF-${row.arrival_number}`,
    counterpartyName: row.supplier?.name ?? null,
    status: row.status,
    total: Number(row.total ?? 0),
    exchangeRate: row.exchange_rate != null ? Number(row.exchange_rate) : null,
    dueDate: row.due_date ?? '',
    invoiceDate: row.invoice_date,
  }
}

/**
 * The invoices a pasted list of numbers is resolved against
 * (lib/invoices/invoice-number-paste): every open invoice of the direction,
 * with the guards searchOpenInvoices / searchOpenSupplierInvoices apply, read
 * whole (an open ledger is at most about a thousand rows), so an OCR or a
 * number a spreadsheet stripped of its leading zeros still resolves; plus
 * the invoices outside that set whose number the paste names, so a paid one
 * is reported as paid and is never confused with an open one. Last, the
 * status-leak guard of loadOpenInvoicesForMatch on the open invoices the
 * paste names: one whose status still says unpaid but has a payment voucher
 * counts as paid.
 */
export async function loadInvoicesForPaste(
  supabase: SupabaseDataClient,
  companyId: string,
  kind: OpenInvoiceKind,
  references: readonly PastedReference[],
): Promise<InvoicesForPaste> {
  const numbers = closedLookupNumbers(references, kind)
  let invoices: PasteLookupInvoice[]
  let capped: boolean
  // Literal select strings throughout: the schema guard checks their columns.
  if (kind === 'customer') {
    // The embed is many-to-one (an object at runtime); the untyped client infers an array.
    const open = (await fetchAllRows(
      ({ from, to }) =>
        supabase
          .from('invoices')
          .select(
            'id, invoice_number, status, total, remaining_amount, currency, exchange_rate, due_date, invoice_date, customer:customers(name)',
          )
          .eq('company_id', companyId)
          .eq('document_type', 'invoice')
          .is('credited_invoice_id', null)
          .in('status', [...MATCHABLE_INVOICE_STATUSES])
          .gt('remaining_amount', 0)
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id, maxRows: PASTE_OPEN_INVOICES_MAX },
    )) as unknown as CustomerPasteRow[]
    capped = open.length >= PASTE_OPEN_INVOICES_MAX
    const openIds = new Set(open.map((row) => row.id))
    const closed: CustomerPasteRow[] = []
    for (const slice of chunk(numbers, IN_READ_CHUNK)) {
      const rows = await rowsOf<CustomerPasteRow>(
        supabase
          .from('invoices')
          .select(
            'id, invoice_number, status, total, remaining_amount, currency, exchange_rate, due_date, invoice_date, customer:customers(name)',
          )
          .eq('company_id', companyId)
          .in('invoice_number', slice),
      )
      closed.push(...rows.filter((row) => !openIds.has(row.id)))
    }
    invoices = [
      ...open.map((row) => customerPasteInvoice(row, 'open')),
      ...closed.map((row) => customerPasteInvoice(row, closedState(row))),
    ]
  } else {
    // The embed is many-to-one (an object at runtime); the untyped client infers an array.
    const open = (await fetchAllRows(
      ({ from, to }) =>
        supabase
          .from('supplier_invoices')
          .select(
            'id, supplier_invoice_number, payment_reference, arrival_number, status, total, remaining_amount, currency, exchange_rate, due_date, invoice_date, supplier:suppliers(name)',
          )
          .eq('company_id', companyId)
          .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
          .gt('remaining_amount', 0)
          .order('id', { ascending: true })
          .range(from, to),
      { dedupeBy: (row) => row.id, maxRows: PASTE_OPEN_INVOICES_MAX },
    )) as unknown as SupplierPasteRow[]
    capped = open.length >= PASTE_OPEN_INVOICES_MAX
    const seen = new Set(open.map((row) => row.id))
    const closed: SupplierPasteRow[] = []
    for (const slice of chunk(numbers, IN_READ_CHUNK)) {
      // By the supplier's invoice number and by its payment reference (OCR).
      const byNumber = await rowsOf<SupplierPasteRow>(
        supabase
          .from('supplier_invoices')
          .select(
            'id, supplier_invoice_number, payment_reference, arrival_number, status, total, remaining_amount, currency, exchange_rate, due_date, invoice_date, supplier:suppliers(name)',
          )
          .eq('company_id', companyId)
          .in('supplier_invoice_number', slice),
      )
      const byReference = await rowsOf<SupplierPasteRow>(
        supabase
          .from('supplier_invoices')
          .select(
            'id, supplier_invoice_number, payment_reference, arrival_number, status, total, remaining_amount, currency, exchange_rate, due_date, invoice_date, supplier:suppliers(name)',
          )
          .eq('company_id', companyId)
          .in('payment_reference', slice),
      )
      for (const row of [...byNumber, ...byReference]) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        closed.push(row)
      }
    }
    invoices = [
      ...open.map((row) => supplierPasteInvoice(row, 'open')),
      ...closed.map((row) => supplierPasteInvoice(row, closedState(row))),
    ]
  }

  const named = resolvePastedReferences(references, invoices, kind)
  const guardIds = new Set<string>()
  for (const resolution of named) {
    if (resolution.kind !== 'one') continue
    const invoice = resolution.invoice
    if (invoice.state === 'open' && invoice.status !== 'partially_paid') guardIds.add(invoice.id)
  }
  if (guardIds.size > 0) {
    const paid = await idsWithPaymentVoucher(supabase, companyId, kind, [...guardIds])
    invoices = invoices.map((invoice) => (paid.has(invoice.id) ? { ...invoice, state: 'paid' as const } : invoice))
  }
  return { invoices, capped }
}
