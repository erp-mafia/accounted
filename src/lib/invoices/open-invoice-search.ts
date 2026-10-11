import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'

/**
 * Open customer and supplier invoices for the transaction match pickers.
 *
 * The pickers used to load the newest PICKER_LIMIT open invoices and filter
 * them in the browser, so a search could never find an older open invoice: it
 * was simply not in the list. A search term now goes to the database, which
 * matches the invoice number or the counterparty name across every open
 * invoice; without a term the newest PICKER_LIMIT still make the default view.
 *
 * The status-leak guard (hide a 'sent'/'approved' row that already has a
 * payment voucher) stays in the pickers: it applies to whatever rows come back.
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
    .in('status', ['sent', 'overdue', 'partially_paid'])
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
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .gt('remaining_amount', 0)
      .ilike('customer.name', pattern)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  return mergeNewestFirst(await Promise.all([byNumber, byCustomer]))
}

/**
 * Open supplier invoices a bank payment can be matched to: past the approval
 * gate and not yet fully settled.
 */
export async function searchOpenSupplierInvoices<T extends PickerRow>(
  supabase: SupabaseClient,
  companyId: string,
  term: string,
): Promise<T[]> {
  // Mirrors match-supplier-invoice: only approved/overdue/partially_paid
  // invoices can take a payment. Registered invoices haven't passed the
  // approval gate yet; paid/credited/reversed are terminal.
  const pattern = pickerSearchPattern(term)
  let byNumberQuery = supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*)')
    .eq('company_id', companyId)
    .in('status', ['approved', 'overdue', 'partially_paid'])
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
      .in('status', ['approved', 'overdue', 'partially_paid'])
      .gt('remaining_amount', 0)
      .ilike('supplier.name', pattern)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: true })
      .limit(PICKER_LIMIT),
  )
  return mergeNewestFirst(await Promise.all([byNumber, bySupplier]))
}
