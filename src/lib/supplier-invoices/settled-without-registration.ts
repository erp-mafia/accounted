/**
 * Read-only: the supplier invoices a payment settled before the
 * registration-first rule (registration-first.ts, 2026-10-16), for a later,
 * reviewed repair. Nothing here writes, and nothing calls it on its own.
 *
 * Before the rule, a deferring company's (defer_invoice_booking) invoice paid
 * before Bokför got only the clearing, Debit 2440 / Credit the bank: the cost
 * and the ingående moms never reached the ledger, 2440 carries a debit no
 * registration credited, and the Bokför step refuses the paid invoice. Such an
 * invoice reads here as: the company books in a separate step now, the invoice
 * is paid or partially paid, it is not a credit note, it has no registration
 * verifikat, and no payment of it is a kontantmetoden cash entry
 * (supplier_invoice_cash_payment, which books the whole invoice).
 *
 * Only deferring companies are read: in a company that books at registration
 * a missing link can be a registration that arrived through SIE or a provider
 * migration, unlinked, and the payment rightly cleared it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { invoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'

export interface SettledWithoutRegistration {
  supplier_invoice_id: string
  arrival_number: number | null
  supplier_invoice_number: string | null
  invoice_date: string
  status: string
  currency: string
  total: number
  paid_amount: number
  /** The posted verifikat of its payments: each cleared 2440 with no registration behind it. */
  payment_journal_entry_ids: string[]
}

const ID_CHUNK = 100
const CASH_ENTRY_SOURCE = 'supplier_invoice_cash_payment'

type InvoiceRow = Omit<SettledWithoutRegistration, 'supplier_invoice_id' | 'payment_journal_entry_ids'> & {
  id: string
}

/** Throws on a read error: a repair list must never be silently short. */
export async function listSettledWithoutRegistration(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SettledWithoutRegistration[]> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw settingsError
  if (invoiceBookingMoment(settings) !== 'manual') return []

  const invoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase
      .from('supplier_invoices')
      .select('id, arrival_number, supplier_invoice_number, invoice_date, status, currency, total, paid_amount')
      .eq('company_id', companyId)
      .is('registration_journal_entry_id', null)
      .eq('is_credit_note', false)
      .in('status', ['paid', 'partially_paid'])
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (invoices.length === 0) return []

  const paymentEntries = new Map<string, Set<string>>()
  for (const ids of chunk(invoices.map((invoice) => invoice.id), ID_CHUNK)) {
    const payments = await fetchAllRows<{ id: string; supplier_invoice_id: string; journal_entry_id: string | null }>(
      ({ from, to }) =>
        supabase
          .from('supplier_invoice_payments')
          .select('id, supplier_invoice_id, journal_entry_id')
          .eq('company_id', companyId)
          .in('supplier_invoice_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
    )
    for (const payment of payments) {
      if (!payment.journal_entry_id) continue
      const set = paymentEntries.get(payment.supplier_invoice_id) ?? new Set<string>()
      set.add(payment.journal_entry_id)
      paymentEntries.set(payment.supplier_invoice_id, set)
    }
  }

  const entrySource = new Map<string, { source_type: string | null; status: string }>()
  const entryIds = [...new Set([...paymentEntries.values()].flatMap((set) => [...set]))]
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const entries = await fetchAllRows<{ id: string; source_type: string | null; status: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, source_type, status')
        .eq('company_id', companyId)
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const entry of entries) entrySource.set(entry.id, { source_type: entry.source_type, status: entry.status })
  }

  const affected: SettledWithoutRegistration[] = []
  for (const invoice of invoices) {
    const ids = [...(paymentEntries.get(invoice.id) ?? [])]
    // A cash entry booked the whole invoice: not a clearing without its registration.
    if (ids.some((id) => entrySource.get(id)?.source_type === CASH_ENTRY_SOURCE)) continue
    const { id, ...fields } = invoice
    affected.push({
      ...fields,
      supplier_invoice_id: id,
      payment_journal_entry_ids: ids.filter((entryId) => entrySource.get(entryId)?.status === 'posted'),
    })
  }
  return affected
}
