/**
 * The payment verifikat of a supplier-invoice bank match, from the plan
 * planSupplierBankMatch (@/lib/invoices/apply-supplier-payment) returns.
 *
 * Two thin dispatchers over the existing generators, next to each other so the
 * preview and the commit cannot pick different builders or inputs:
 *
 *   createSupplierBankMatchEntry   books it: the dashboard POST and the v1 POST
 *   buildSupplierBankMatchLines    the same lines, pure: the dashboard preview
 *
 * Both hand every input the plan carries (the 6570 bank fee and the 3740 SEK
 * clearing debt included) to the builder, so no door can drop one again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildSupplierInvoiceCashLines,
  buildSupplierInvoicePaymentLines,
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import type { SupplierBankMatchBooking } from '@/lib/invoices/apply-supplier-payment'
import type {
  CreateJournalEntryLineInput,
  JournalEntry,
  SupplierInvoice,
  Transaction,
} from '@/types'

function supplierType(invoice: SupplierInvoice): string {
  return invoice.supplier?.supplier_type || 'swedish_business'
}

/**
 * The verifikat header names the supplier on a SEK clearing, as the dashboard
 * has booked it since #3231. The foreign leg's line texts stay without it:
 * they are the rows the preview shows, and it does not fetch the name.
 */
function clearingSupplierName(
  invoice: SupplierInvoice,
  booking: Extract<SupplierBankMatchBooking, { kind: 'clearing' }>,
): string | undefined {
  return booking.sekClearingDebt !== undefined ? invoice.supplier?.name : undefined
}

/**
 * Book the payment verifikat of a supplier bank match. Returns null when no
 * open period covers the transaction date (the routes check that first).
 */
export async function createSupplierBankMatchEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  args: {
    invoice: SupplierInvoice
    booking: SupplierBankMatchBooking
    paymentAccount: string
    transaction: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>
  },
): Promise<JournalEntry | null> {
  const { invoice, booking, paymentAccount, transaction } = args
  if (booking.kind === 'cash') {
    return createSupplierInvoiceCashEntry(
      supabase, companyId, userId, invoice,
      invoice.items ?? [],
      transaction.date,
      supplierType(invoice),
      undefined, // supplierName (unchanged default)
      paymentAccount,
      booking.settledBankSek,
      transaction,
      booking.bankFeeSek,
    )
  }
  return createSupplierInvoicePaymentEntry(
    supabase, companyId, userId, invoice,
    booking.paymentAmount,
    transaction.date,
    booking.exchangeRateDifference,
    clearingSupplierName(invoice, booking),
    paymentAccount,
    transaction,
    booking.bankFeeSek,
    booking.sekClearingDebt,
  )
}

/**
 * The lines createSupplierBankMatchEntry books for the same plan, without
 * booking them. Throws SupplierInvoiceFxRateMissingError (code
 * SI_FX_RATE_MISSING) for a kontantmetoden foreign invoice with no usable rate,
 * as the booking does.
 */
export function buildSupplierBankMatchLines(
  invoice: SupplierInvoice,
  booking: SupplierBankMatchBooking,
  paymentAccount: string,
): { lines: CreateJournalEntryLineInput[]; oreDiffSek: number } {
  if (booking.kind === 'cash') {
    const built = buildSupplierInvoiceCashLines(invoice, invoice.items ?? [], supplierType(invoice), {
      paymentAccount,
      settledBankSek: booking.settledBankSek,
      bankFeeSek: booking.bankFeeSek,
    })
    return { lines: built.lines, oreDiffSek: built.oreDiffSek }
  }
  const built = buildSupplierInvoicePaymentLines(invoice, {
    paymentAmount: booking.paymentAmount,
    exchangeRateDifference: booking.exchangeRateDifference,
    supplierName: clearingSupplierName(invoice, booking),
    paymentAccount,
    bankFeeSek: booking.bankFeeSek,
    sekClearingDebt: booking.sekClearingDebt,
  })
  return { lines: built.lines, oreDiffSek: built.oreDiffSek }
}
