import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Coverage of the invoice register (the `invoices` table) relative to the
 * company's bookkeeping. The register only holds invoices created in
 * Accounted: a company migrated mid-year (SIE import) or backfilled through
 * manual/API verifikat has real customer invoices that exist ONLY as journal
 * entries. Every surface that answers "which invoices do we have" from the
 * register alone looks complete while silently omitting that period; this
 * helper computes the disclosure those surfaces show.
 *
 * Detection is AR-based, not import-based: `fetchMigrationCoverageEnd()`
 * keys on source_type='import', which misses invoice history recreated as
 * plain manual verifikat (the 2026-09-01 user report: a full spring of
 * "Kundfaktura NNN" vouchers with source_type='manual'). An invoice booked
 * as a verifikat carries the receivable on 1510/1513, so posted AR lines
 * dated before the register's first invoice, from any source other than the
 * invoice engine itself, are the signal. Kontantmetod invoice history booked
 * straight against 1930 stays undetected; accepted, because widening to all
 * class-3 revenue would flag cash sales (webshop orders, kassa) that were
 * never register material.
 */
export interface InvoiceRegisterCoverage {
  /**
   * Earliest invoice_date in the register, i.e. where register-backed
   * answers start being complete. Null when the register is empty (the
   * empty state already routes the user to migration; no marker needed).
   */
  covers_from: string | null
  /**
   * True when posted non-invoice-engine verifikat carry AR (1510/1513)
   * lines dated before covers_from: invoices likely exist outside the
   * register for that period.
   */
  has_pre_register_invoices: boolean
}

export const NO_INVOICE_REGISTER_COVERAGE: InvoiceRegisterCoverage = {
  covers_from: null,
  has_pre_register_invoices: false,
}

export async function fetchInvoiceRegisterCoverage(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoiceRegisterCoverage> {
  const { data: firstInvoice } = await supabase
    .from('invoices')
    .select('invoice_date')
    .eq('company_id', companyId)
    .order('invoice_date', { ascending: true })
    .limit(1)
    .maybeSingle()

  const coversFrom = (firstInvoice as { invoice_date?: string } | null)?.invoice_date ?? null
  if (!coversFrom) return NO_INVOICE_REGISTER_COVERAGE

  // One AR line before the boundary is enough; the join filter keeps the
  // check company-scoped (journal_entry_lines has no company_id column).
  // Excluding invoice_created/invoice_paid leaves storno/correction rows of
  // engine entries in scope; those are dated at or after their originals,
  // which the register already covers, so they cannot create the signal on
  // their own.
  const { data: arLine } = await supabase
    .from('journal_entry_lines')
    .select('id, journal_entry:journal_entries!inner(id)')
    .in('account_number', ['1510', '1513'])
    .eq('journal_entry.company_id', companyId)
    .eq('journal_entry.status', 'posted')
    .lt('journal_entry.entry_date', coversFrom)
    .not('journal_entry.source_type', 'in', '("invoice_created","invoice_paid")')
    .limit(1)
    .maybeSingle()

  return {
    covers_from: coversFrom,
    has_pre_register_invoices: arLine != null,
  }
}
