import { resolveSekAmountOrNull } from './currency-utils'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { dbError } from '@/lib/errors/db-error'
import { MAX_CHAIN_WALK } from '@/lib/core/bookkeeping/correction-chain'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupplierInvoice } from '@/types'

interface PostedPayable {
  registeredSek: number
  settledSek: number
}

export class SupplierPaymentBalanceError extends Error {
  readonly code = 'SI_PAYMENT_BALANCE_UNAVAILABLE'

  constructor(reason: string) {
    super(reason)
    this.name = 'SupplierPaymentBalanceError'
  }
}

/**
 * Allocate the remaining posted liability over the remaining invoice currency.
 * Full settlement consumes the actual SEK remainder, including rounding from
 * registration, bank matching and surviving payments after a reversal.
 * Only an unpaid legacy invoice without a registration link uses FX fields.
 */
export function supplierInvoicePaymentSek(
  invoice: Pick<SupplierInvoice, 'currency' | 'total' | 'total_sek' | 'exchange_rate' | 'paid_amount'>,
  paymentAmount: number,
  posted?: PostedPayable,
): number | null {
  if (!invoice.currency || invoice.currency === 'SEK') return roundOre(paymentAmount)

  const totalSek = posted?.registeredSek ?? resolveSekAmountOrNull(
    invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate,
  )
  if (totalSek == null || !Number.isFinite(totalSek) || totalSek <= 0) return null
  const paid = invoice.paid_amount ?? 0
  // Invoice-currency history cannot tell us how many SEK were actually posted.
  if (paid > 0 && !posted) return null
  const remainingCurrency = roundOre(invoice.total - paid)
  const remainingSek = roundOre(totalSek - (posted?.settledSek ?? 0))
  if (!Number.isFinite(remainingSek) || remainingSek <= 0
    || !Number.isFinite(remainingCurrency) || remainingCurrency <= 0
    || !Number.isFinite(paymentAmount) || paymentAmount <= 0
    || roundOre(paymentAmount) > remainingCurrency) return null

  return roundOre(remainingSek * roundOre(paymentAmount) / remainingCurrency)
}

interface PaymentRow {
  id: string
  amount: number
  currency: string
  journal_entry_id: string | null
}

interface EntryRow {
  id: string
  status: string
  correction_of_id: string | null
}

function unavailable(reason: string): never {
  throw new SupplierPaymentBalanceError(reason)
}

/**
 * Resolve only vouchers linked to this invoice, never a company-wide 2440 sum.
 * Journal lines carry the current inline corrections; storno corrections are
 * followed to their live replacement. Reversed payments disappear from payment
 * history via payment-sync. Incomplete or shared links require reconciliation,
 * not a reconstructed SEK amount that could silently mark the wrong debt paid.
 */
export async function resolveSupplierInvoicePaymentSek(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice,
  paymentAmount: number,
): Promise<number | null> {
  if (!invoice.currency || invoice.currency === 'SEK') return roundOre(paymentAmount)

  if (roundOre(invoice.total - (invoice.paid_amount ?? 0)) !== roundOre(invoice.remaining_amount)) {
    unavailable('Invoice remaining amount does not agree with its payment state')
  }
  const registrationId = invoice.registration_journal_entry_id
  if (!registrationId) {
    if (invoice.paid_amount > 0) unavailable('Part-paid invoice has no linked registration voucher')
    return supplierInvoicePaymentSek(invoice, paymentAmount)
  }

  const payments = await fetchAllRows<PaymentRow>(({ from, to }) => supabase
    .from('supplier_invoice_payments')
    .select('id, amount, currency, journal_entry_id')
    .eq('company_id', companyId).eq('supplier_invoice_id', invoice.id)
    .order('id').range(from, to))
  if (payments.some(p => !p.journal_entry_id || p.currency !== invoice.currency)
    || roundOre(payments.reduce((sum, p) => sum + p.amount, 0)) !== roundOre(invoice.paid_amount ?? 0)) {
    unavailable('Payment history does not explain the invoice paid amount')
  }

  const roots = [registrationId, ...payments.map(p => p.journal_entry_id!)]
  if (new Set(roots).size !== roots.length) unavailable('Invoice links the same voucher more than once')
  const linkedIds = new Set(roots)

  // Bound IN lists as well as paginating rows: long partial-payment histories
  // must not exceed either PostgREST's row cap or the HTTP URL limit.
  const liveEntries = new Map<string, EntryRow>()
  for (let offset = 0; offset < roots.length; offset += 100) {
    const ids = roots.slice(offset, offset + 100)
    const entries = await fetchAllRows<EntryRow>(({ from, to }) => supabase
      .from('journal_entries').select('id, status, correction_of_id')
      .eq('company_id', companyId).in('id', ids).order('id').range(from, to))
    for (const id of ids) {
      const entry = entries.find(e => e.id === id)
      if (!entry) unavailable('Linked voucher is missing')
      liveEntries.set(id, entry)
    }
  }

  for (let depth = 0; depth < MAX_CHAIN_WALK; depth++) {
    const reversed = [...liveEntries].filter(([, e]) => e.status === 'reversed')
    if (reversed.length === 0) break
    for (let offset = 0; offset < reversed.length; offset += 100) {
      const batch = reversed.slice(offset, offset + 100)
      const replacements = await fetchAllRows<EntryRow>(({ from, to }) => supabase
        .from('journal_entries').select('id, status, correction_of_id')
        .eq('company_id', companyId).in('correction_of_id', batch.map(([, e]) => e.id))
        .in('status', ['posted', 'reversed']).order('id').range(from, to))
      for (const [root, entry] of batch) {
        const children = replacements.filter(e => e.correction_of_id === entry.id)
        if (children.length !== 1) unavailable('Reversed voucher has no unambiguous correction')
        liveEntries.set(root, children[0])
        linkedIds.add(children[0].id)
      }
    }
  }
  if ([...liveEntries.values()].some(e => e.status !== 'posted')) {
    unavailable('Linked voucher is not posted or its correction chain is too deep')
  }

  const liveIds = [...liveEntries.values()].map(e => e.id)
  if (new Set(liveIds).size !== liveIds.length) unavailable('Invoice links the same corrected voucher more than once')
  const ids = [...linkedIds]
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    // A batch voucher can clear several invoices. Its entire 2440 debit must
    // never be attributed to one payment row; there is no line-level link.
    const { data: sharedPayments, error: paymentError } = await supabase
      .from('supplier_invoice_payments').select('id')
      .eq('company_id', companyId).in('journal_entry_id', batch)
      .neq('supplier_invoice_id', invoice.id).limit(1)
    if (paymentError) throw dbError(paymentError)
    const { data: sharedRegistrations, error: registrationError } = await supabase
      .from('supplier_invoices').select('id')
      .eq('company_id', companyId).in('registration_journal_entry_id', batch)
      .neq('id', invoice.id).limit(1)
    if (registrationError) throw dbError(registrationError)
    if (sharedPayments?.length || sharedRegistrations?.length) unavailable('Voucher is shared with another invoice')
  }

  const balances = new Map<string, number>()
  for (let offset = 0; offset < liveIds.length; offset += 100) {
    const batch = liveIds.slice(offset, offset + 100)
    const lines = await fetchAllRows<{
      journal_entry_id: string; debit_amount: number; credit_amount: number
    }>(({ from, to }) => supabase.from('journal_entry_lines')
      .select('id, journal_entry_id, debit_amount, credit_amount, journal_entries!inner(company_id)')
      .eq('journal_entries.company_id', companyId).in('journal_entry_id', batch)
      .eq('account_number', '2440').order('id').range(from, to))
    for (const line of lines) {
      balances.set(line.journal_entry_id, (balances.get(line.journal_entry_id) ?? 0)
        + line.credit_amount - line.debit_amount)
    }
  }
  if (liveIds.some(id => !balances.has(id))) unavailable('Linked voucher has no 2440 lines')
  const registeredSek = roundOre(balances.get(liveEntries.get(registrationId)!.id)!)
  const settledSek = roundOre(payments.reduce((sum, p) =>
    sum - balances.get(liveEntries.get(p.journal_entry_id!)!.id)!, 0))
  const amount = supplierInvoicePaymentSek(invoice, paymentAmount, { registeredSek, settledSek })
  if (amount == null || amount <= 0) unavailable('Posted liability cannot cover this payment')
  return amount
}
