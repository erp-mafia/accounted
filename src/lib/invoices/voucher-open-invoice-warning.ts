/**
 * The invoicing block's booking-time warning for a typed verifikat
 * (contract: lib/bookkeeping/voucher-block-warnings.ts): the verifikat
 * settles kundfordringar or leverantörsskulder by exactly what an open
 * invoice has left to pay.
 *
 * A payment is meant to be matched to its invoice: the match books the same
 * lines and marks the invoice paid. A verifikat typed straight onto the
 * control account books the money but leaves the invoice open, so the
 * reskontra keeps saying "unpaid" while the account says "settled". The bank
 * row door already stops for this (the invoice-match intercept of
 * categorize); a typed verifikat did not ask.
 *
 * What counts: the verifikat's net credit on the customer receivables
 * account, or its net debit on the supplier payables account, equal to the
 * remaining amount of an invoice that is still owed (customer: sent, overdue,
 * partly paid; supplier: registered, approved, overdue, partly paid).
 * Invoices in kronor only: a foreign invoice's remaining amount is not the
 * amount the account carries. A rättelse and an ingående balans are left
 * alone: neither is a payment being typed.
 *
 * The person confirms like every other warning (acknowledged_warnings) when
 * the posting is meant: a kvittning, a correction of an earlier mistake.
 * Throws when a read fails; the guard never lets that stop a booking.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { MATCHABLE_SUPPLIER_INVOICE_STATUSES, OWED_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import type { VoucherBlockWarningInput } from '@/lib/bookkeeping/voucher-block-warnings'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

/** At most this many invoices are named; one is the usual case. */
const NAMED_INVOICES = 3

interface CoveredInvoice {
  kind: 'customer' | 'supplier'
  id: string
  number: string
}

export async function openInvoiceVoucherWarning(
  supabase: SupabaseClient,
  companyId: string,
  input: VoucherBlockWarningInput,
): Promise<VoucherWarning | null> {
  if (input.replaces || input.opening_balance) return null

  const receivableAccount = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')
  const payableAccount = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')
  let receivableSettled = 0
  let payableSettled = 0
  for (const line of input.lines) {
    const debit = Number(line.debit_amount) || 0
    const credit = Number(line.credit_amount) || 0
    if (line.account_number === receivableAccount) receivableSettled += credit - debit
    else if (line.account_number === payableAccount) payableSettled += debit - credit
  }
  receivableSettled = roundOre(receivableSettled)
  payableSettled = roundOre(payableSettled)
  if (receivableSettled <= 0 && payableSettled <= 0) return null

  const covered: CoveredInvoice[] = []
  let amount = 0
  let account = ''

  if (receivableSettled > 0) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, currency')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', [...OWED_INVOICE_STATUSES])
      .eq('remaining_amount', receivableSettled)
      .limit(NAMED_INVOICES)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as Array<{ id: string; invoice_number: string | null; currency: string | null }>) {
      if (!isKronorCurrency(row.currency)) continue
      covered.push({ kind: 'customer', id: row.id, number: row.invoice_number ?? '' })
    }
    if (covered.length > 0) {
      amount = receivableSettled
      account = receivableAccount
    }
  }

  if (covered.length === 0 && payableSettled > 0) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, arrival_number, currency')
      .eq('company_id', companyId)
      .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
      .eq('remaining_amount', payableSettled)
      .is('reversed_at', null)
      .limit(NAMED_INVOICES)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as Array<{
      id: string
      supplier_invoice_number: string | null
      arrival_number: number | string | null
      currency: string | null
    }>) {
      if (!isKronorCurrency(row.currency)) continue
      covered.push({
        kind: 'supplier',
        id: row.id,
        number: row.supplier_invoice_number ?? (row.arrival_number != null ? String(row.arrival_number) : ''),
      })
    }
    if (covered.length > 0) {
      amount = payableSettled
      account = payableAccount
    }
  }

  if (covered.length === 0) return null

  const customer = covered[0].kind === 'customer'
  const numbers = covered.map((c) => c.number).filter(Boolean).join(', ')
  const namedSv = numbers ? ` ${numbers}` : ''
  const namedEn = numbers ? ` ${numbers}` : ''
  const several = covered.length > 1
  return {
    code: 'OPEN_INVOICE_COVERS_POSTING',
    message_sv:
      `Verifikationen bokar ${formatCurrency(amount)} mot konto ${account}, precis vad ` +
      (customer
        ? several ? `kundfakturorna${namedSv} var för sig har kvar att betala` : `kundfaktura${namedSv} har kvar att betala`
        : several ? `leverantörsfakturorna${namedSv} var för sig har kvar att betala` : `leverantörsfaktura${namedSv} har kvar att betala`) +
      '. Matcha betalningen mot fakturan i stället: annars står fakturan kvar som obetald i reskontran.',
    message_en:
      `The verifikat posts ${formatCurrency(amount)} to account ${account}, exactly what ` +
      (customer
        ? several ? `customer invoices${namedEn} each have left to pay` : `customer invoice${namedEn} has left to pay`
        : several ? `supplier invoices${namedEn} each have left to pay` : `supplier invoice${namedEn} has left to pay`) +
      '. Match the payment to the invoice instead: otherwise the invoice stays open in the ledger of open invoices.',
    details: {
      account_number: account,
      amount,
      invoices: covered.map((c) => ({ kind: c.kind, id: c.id })),
    },
  }
}
