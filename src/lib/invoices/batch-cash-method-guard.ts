import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Kontantmetoden guard for the samlingsbetalning / batch allocation
 * (match_batch_allocate RPC).
 *
 * The RPC settles every allocation as a pure clearing entry: customer
 * invoices are credited to 1510, supplier invoices debited to 2440. That is
 * correct only when the invoice already sits on the ledger (booked at issue
 * or registration). Under kontantmetoden nothing is booked at issue: revenue
 * + utgående moms (or cost + ingående moms) are recognised at PAYMENT. A
 * batch over such invoices therefore books the bank movement against an
 * empty 1510/2440 and the sale or purchase, with its moms, never reaches the
 * ledger at all.
 *
 * The per-invoice paths already book these correctly through the generated
 * cash entries (createInvoiceCashEntry / the supplier cash entry): a direct
 * single-invoice match, or "Markera som betald" followed by linking the bank
 * row to the resulting vouchers. So the batch refuses and routes there,
 * instead of growing a second kontantmetoden booking implementation inside
 * the RPC.
 *
 * The test mirrors the single-invoice routes: the invoice's own booking
 * state decides, not only the company setting. An invoice booked at issue
 * before a switch to kontantmetoden still has a receivable/payable to clear,
 * so the batch stays allowed for it.
 */

export interface BatchAllocationRef {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string | null
  supplier_invoice_id?: string | null
}

export interface CashMethodUnbookedInvoice {
  kind: 'customer_invoice' | 'supplier_invoice'
  id: string
  invoice_number: string | null
}

export type CashMethodBatchCheck =
  | { ok: true; unbooked: CashMethodUnbookedInvoice[] }
  | { ok: false; error: unknown }

export async function findCashMethodUnbookedAllocations(
  supabase: SupabaseClient,
  companyId: string,
  allocations: readonly BatchAllocationRef[],
): Promise<CashMethodBatchCheck> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, error: settingsError }
  // No settings row: the historical default is accrual, same as every other
  // booking path.
  if ((settings?.accounting_method || 'accrual') !== 'cash') return { ok: true, unbooked: [] }

  const customerIds = Array.from(
    new Set(
      allocations.flatMap((a) =>
        a.kind === 'customer_invoice' && a.invoice_id ? [a.invoice_id] : [],
      ),
    ),
  )
  const supplierIds = Array.from(
    new Set(
      allocations.flatMap((a) =>
        a.kind === 'supplier_invoice' && a.supplier_invoice_id ? [a.supplier_invoice_id] : [],
      ),
    ),
  )

  const unbooked: CashMethodUnbookedInvoice[] = []

  if (customerIds.length > 0) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, journal_entry_id')
      .in('id', customerIds)
      .eq('company_id', companyId)
    if (error) return { ok: false, error }
    for (const row of (data ?? []) as {
      id: string
      invoice_number: string | null
      journal_entry_id: string | null
    }[]) {
      if (!row.journal_entry_id) {
        unbooked.push({ kind: 'customer_invoice', id: row.id, invoice_number: row.invoice_number })
      }
    }
  }

  if (supplierIds.length > 0) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, registration_journal_entry_id')
      .in('id', supplierIds)
      .eq('company_id', companyId)
    if (error) return { ok: false, error }
    for (const row of (data ?? []) as {
      id: string
      supplier_invoice_number: string | null
      registration_journal_entry_id: string | null
    }[]) {
      if (!row.registration_journal_entry_id) {
        unbooked.push({
          kind: 'supplier_invoice',
          id: row.id,
          invoice_number: row.supplier_invoice_number,
        })
      }
    }
  }

  return { ok: true, unbooked }
}
