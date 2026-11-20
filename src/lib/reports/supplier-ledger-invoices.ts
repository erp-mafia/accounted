import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'

/**
 * The leverantörsreskontra population in one read:
 * get_supplier_ledger_invoices
 * (supabase/migrations/20261023094010_supplier_ledger_invoices_rpc.sql), the
 * supplier twin of ar-ledger-invoices.ts. The supplier ledger, its 2440
 * reconciliation and the supplier drill-down read it instead of paging
 * `supplier_invoices` and the payment rows; the rules stay in
 * supplier-ledger.ts and reskontra-payments.ts.
 *
 * As of a date, paid invoices provably settled by the date are not returned
 * (the ledger walk skips them); see the migration. Rows come in id order.
 */

/** The registration verifikat of an invoice (drill-down reads only). */
export interface SupplierLedgerInvoiceEntry {
  voucher_number: number
  voucher_series: string | null
  description: string | null
  entry_date: string
}

export interface SupplierLedgerInvoice {
  id: string
  supplier_id: string
  supplier_name: string | null
  supplier_invoice_number: string | null
  arrival_number: number | null
  invoice_date: string
  due_date: string
  status: string
  total: number | null
  paid_amount: number | null
  remaining_amount: number | null
  currency: string | null
  exchange_rate: number | null
  paid_at: string | null
  registration_journal_entry_id: string | null
  /** As of a date: the invoice has payment rows at all, of any date (InvoicePaymentFacts). */
  has_payment_rows: boolean
  /** As of a date: the amounts of its payment rows dated on or before it, in id order. */
  payment_amounts: number[] | null
  /** Only with `supplierId`: the registration verifikat when posted, or null. */
  registration_entry?: SupplierLedgerInvoiceEntry | null
}

export interface SupplierLedgerInvoicesOptions {
  /** Reconstruct the population as of this date; omitted, the live state. */
  asOfDate?: string
  /** One supplier's invoices, with their registration verifikat. */
  supplierId?: string
}

/**
 * The ledger population, live or as of a date. Throws on a failed read (with
 * the SQLSTATE kept, see lib/errors/db-error.ts).
 */
export async function fetchSupplierLedgerInvoices(
  supabase: SupabaseClient,
  companyId: string,
  options: SupplierLedgerInvoicesOptions = {},
): Promise<SupplierLedgerInvoice[]> {
  const { data, error } = await supabase.rpc('get_supplier_ledger_invoices', {
    p_company_id: companyId,
    p_as_of_date: options.asOfDate ?? null,
    p_supplier_id: options.supplierId ?? null,
  })
  if (error) throw dbError(error, 'get_supplier_ledger_invoices failed')
  return (Array.isArray(data) ? data : []) as SupplierLedgerInvoice[]
}
