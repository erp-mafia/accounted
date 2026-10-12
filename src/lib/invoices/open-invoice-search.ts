import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/invoices/matchable-statuses'

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
 * (lib/invoices/matchable-statuses): offering anything else gives a confirm
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
  supabase: SupabaseClient,
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
  supabase: SupabaseClient,
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
  supabase: SupabaseClient,
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

  // Literal select strings, one per table: the schema guard checks their columns.
  const paidIds =
    kind === 'customer'
      ? (
          await rowsOf<{ invoice_id: string }>(
            supabase
              .from('invoice_payments')
              .select('invoice_id')
              .eq('company_id', companyId)
              .in('invoice_id', fullIds)
              .not('journal_entry_id', 'is', null),
          )
        ).map((r) => r.invoice_id)
      : (
          await rowsOf<{ supplier_invoice_id: string }>(
            supabase
              .from('supplier_invoice_payments')
              .select('supplier_invoice_id')
              .eq('company_id', companyId)
              .in('supplier_invoice_id', fullIds)
              .not('journal_entry_id', 'is', null),
          )
        ).map((r) => r.supplier_invoice_id)
  const paid = new Set(paidIds)
  return { rows: all.filter((inv) => !paid.has(inv.id)), capped: all.length >= PICKER_LIMIT }
}
