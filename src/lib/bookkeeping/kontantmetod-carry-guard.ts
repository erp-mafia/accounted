/**
 * Readable refusals for a storno or a rättelse of a kontantmetod year-end
 * carry (årsomföring, #3440), before anything is written.
 *
 * A carry is the year_end verifikat that books one invoice open at the year
 * end onto 1510 / 2440 with its revenue or cost and moms, marked in
 * kontantmetod_cutoff_entries (kind receivable_invoice / payable_invoice) and
 * linked through invoices.journal_entry_id / supplier_invoices.
 * registration_journal_entry_id. The database owns the rules
 * (kontantmetod_carry_on_reversal, 20261018131100, narrowed in 20261018131120): it releases the invoice
 * link on a storno and refuses a storno that would strand a settlement or
 * move the moms to another VAT period, and a rättelse of a carry. A refusal
 * there lands on the engine's compare-and-set, where it can only read as
 * "already reversed". These checks give the same answers first, by name.
 *
 * Fail-open on a read error, deliberately: the database is the authority and
 * refuses whatever slips past here, so a failed read must not block an
 * ordinary year_end storno that has nothing to do with the cut-off.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('kontantmetod-carry-guard')

export interface KontantmetodCarryRef {
  entryId: string
  kind: 'receivable_invoice' | 'payable_invoice'
  invoiceId: string | null
  supplierInvoiceId: string | null
}

/** The per-invoice carry marker of `entryId`, or null when it is not a carry. */
export async function findKontantmetodCarry(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
): Promise<KontantmetodCarryRef | null> {
  const { data, error } = await supabase
    .from('kontantmetod_cutoff_entries')
    .select('kind, invoice_id, supplier_invoice_id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .in('kind', ['receivable_invoice', 'payable_invoice'])
    .limit(1)
  if (error) {
    log.warn('carry marker read failed; leaving the decision to the database', {
      companyId,
      entryId,
      message: error.message,
    })
    return null
  }
  const row = ((data ?? []) as Array<{
    kind: string
    invoice_id: string | null
    supplier_invoice_id: string | null
  }>)[0]
  if (!row || (row.kind !== 'receivable_invoice' && row.kind !== 'payable_invoice')) return null
  return {
    entryId,
    kind: row.kind,
    invoiceId: row.invoice_id,
    supplierInvoiceId: row.supplier_invoice_id,
  }
}

/**
 * True when the carried invoice has a payment row dated after the carry, or a
 * credit note with a posted verifikat: the same test as the database's
 * KONTANTMETOD_CARRY_HAS_SETTLEMENTS (20261018131120). A payment dated on or
 * before the carry (a part paid in the closed year, which sized a residual
 * carry) cleared nothing the carry booked, so it does not hold the carry in
 * place. Without `carryEntryDate` every payment row counts.
 */
export async function kontantmetodCarryHasSettlements(
  supabase: SupabaseClient,
  companyId: string,
  carry: KontantmetodCarryRef,
  carryEntryDate?: string | null,
): Promise<boolean> {
  const customer = carry.kind === 'receivable_invoice'
  const invoiceId = customer ? carry.invoiceId : carry.supplierInvoiceId
  if (!invoiceId) return false

  const [payments, creditNotes] = await Promise.all([
    customer
      ? supabase
          .from('invoice_payments')
          .select('id')
          .eq('company_id', companyId)
          .eq('invoice_id', invoiceId)
          .gt('payment_date', carryEntryDate ?? '0001-01-01')
          .limit(1)
      : supabase
          .from('supplier_invoice_payments')
          .select('id')
          .eq('company_id', companyId)
          .eq('supplier_invoice_id', invoiceId)
          .gt('payment_date', carryEntryDate ?? '0001-01-01')
          .limit(1),
    customer
      ? supabase
          .from('invoices')
          .select('id, journal_entry_id')
          .eq('company_id', companyId)
          .eq('credited_invoice_id', invoiceId)
      : supabase
          .from('supplier_invoices')
          .select('id, registration_journal_entry_id')
          .eq('company_id', companyId)
          .eq('credited_invoice_id', invoiceId),
  ])
  if (payments.error || creditNotes.error) {
    log.warn('carry settlement read failed; leaving the decision to the database', {
      companyId,
      invoiceId,
      message: payments.error?.message ?? creditNotes.error?.message,
    })
    return false
  }
  if ((payments.data ?? []).length > 0) return true

  const creditEntryIds = ((creditNotes.data ?? []) as Array<{
    journal_entry_id?: string | null
    registration_journal_entry_id?: string | null
  }>)
    .map((row) => (customer ? row.journal_entry_id : row.registration_journal_entry_id))
    .filter((id): id is string => !!id)
  if (creditEntryIds.length === 0) return false

  const { data: posted, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .in('id', creditEntryIds)
    .eq('status', 'posted')
    .limit(1)
  if (error) {
    log.warn('credit note verifikat read failed; leaving the decision to the database', {
      companyId,
      invoiceId,
      message: error.message,
    })
    return false
  }
  return (posted ?? []).length > 0
}
