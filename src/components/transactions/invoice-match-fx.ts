/**
 * Pure FX predicates for the invoice-match confirm dialog.
 *
 * Lives outside InvoiceMatchDialog.tsx (which is a `'use client'` component)
 * so the rule below can be unit tested: this repo runs Vitest in the `node`
 * environment and never renders components, so logic embedded in JSX is
 * unverifiable by construction.
 *
 * # Why this exists
 *
 * A cross-currency settlement has THREE distinct states, and the dialog has to
 * show a different thing for each:
 *
 *   1. No FX at all: the invoice and the bank transaction share a currency, or
 *      the invoice is a SEK invoice (a SEK receivable already carries its own
 *      SEK value). Nothing to convert, nothing to warn about.
 *   2. Foreign invoice WITH a booked rate: the kursvinst / kursförlust is a
 *      real, computable number and the dialog previews it.
 *   3. Foreign invoice WITHOUT a booked rate: the SEK value the receivable was
 *      posted at was never established, so the FX result of the settlement is
 *      UNDEFINED, not zero. buildInvoicePaymentClearingLines refuses to build
 *      the verifikat at all (MATCH_INVOICE_BOOKING_RATE_MISSING), so the
 *      dialog must say the booking cannot be made rather than preview a
 *      confident figure.
 *
 * State 3 was previously indistinguishable from state 1 on screen: the dialog
 * read `invoice.exchange_rate ?? 0` behind a `> 0` guard, so a missing rate
 * suppressed the FX note entirely and the user approved an apparent "no FX
 * effect" while the committed entry posted a phantom kursvinst.
 */
import { isValidExchangeRate } from '@/lib/utils'
import { MATCH_INVOICE_BOOKING_RATE_MISSING } from '@/lib/bookkeeping/invoice-payment-lines'

export { MATCH_INVOICE_BOOKING_RATE_MISSING }

export interface InvoiceBookingRateInput {
  /** Currency of the bank transaction being matched. */
  transactionCurrency: string | null | undefined
  /** Currency the invoice was issued in. */
  invoiceCurrency: string | null | undefined
  /** `invoices.exchange_rate`: the rate the 1510 receivable was booked at. */
  invoiceExchangeRate: number | null | undefined
  /**
   * `entry_type` of a SUCCESSFUL preview, or null when the preview route
   * returned an error (or has not resolved yet).
   */
  previewEntryType: 'clearing' | 'cash' | null
  /**
   * `error.code` from a FAILED preview response, or null. The preview route
   * calls the same line builder the POST commits with, so a
   * MATCH_INVOICE_BOOKING_RATE_MISSING here is the authoritative answer: the
   * server has already refused to value the settlement.
   */
  previewErrorCode: string | null
}

/**
 * True when the settlement cannot be booked because the invoice carries no
 * usable exchange rate. Mirrors `requireInvoiceBookingRate` in
 * `lib/bookkeeping/invoice-payment-lines.ts` so the dialog blocks exactly the
 * cases the booking path refuses, and no others.
 *
 * Two independent routes to true, deliberately:
 *
 *   - The preview route already threw with the structured code. This is the
 *     live path today: the preview 400s, so there are no lines to render and
 *     the dialog has nothing but the code to go on.
 *   - The preview SUCCEEDED on a clearing entry whose invoice rate is
 *     unusable. Unreachable while the route keeps throwing, but it keeps the
 *     dialog honest if the route ever starts returning lines for this case
 *     instead: the screen must never present a bookable-looking preview whose
 *     FX result is undefined.
 *
 * Deliberately NOT true for a SEK invoice settled by a foreign bank
 * transaction. `fx_conversion.required` is set there too (the currencies
 * differ), but the line builder takes the `!invoiceIsForeign` branch, never
 * consults `invoice.exchange_rate`, and posts no 3960/7960 line. A SEK invoice
 * has `exchange_rate = null` by construction (`lib/invoices/build-invoice-
 * write.ts` only fetches a rate for non-SEK invoices), so keying off the rate
 * alone would block every one of those perfectly bookable settlements.
 */
export function isInvoiceBookingRateMissing(input: InvoiceBookingRateInput): boolean {
  if (input.previewErrorCode === MATCH_INVOICE_BOOKING_RATE_MISSING) return true

  // Only the clearing entry values the AR leg at the invoice's booking rate.
  // The cash entry (kontantmetoden, unbooked invoice, fully paid) posts
  // revenue and VAT directly and never touches 1510.
  if (input.previewEntryType !== 'clearing') return false

  const { transactionCurrency, invoiceCurrency, invoiceExchangeRate } = input
  if (!invoiceCurrency || invoiceCurrency === 'SEK') return false
  if (!transactionCurrency || transactionCurrency === invoiceCurrency) return false

  return !isValidExchangeRate(invoiceExchangeRate)
}

/**
 * The kursvinst / kursförlust the previewed verifikat actually posts, in SEK.
 * Positive = kursvinst (3960 credit), negative = kursförlust (7960 debit),
 * 0 = the entry has no FX line.
 *
 * Read OFF the previewed lines rather than recomputed from the invoice on
 * purpose: the preview and the POST both build their lines with
 * buildInvoicePaymentClearingLines, so the figure the user approves is the
 * figure that gets booked, by construction. The previous local recomputation
 * could disagree with it in two ways: it defaulted a missing invoice rate to
 * zero (previewing no FX result while a phantom kursvinst got booked), and it
 * read `transaction.amount` as SEK, which is wrong whenever the bank
 * transaction is itself in a foreign currency.
 */
export function previewedFxGainSek(
  lines: { account_number: string; debit_amount: number; credit_amount: number }[],
): number {
  const fxLine = lines.find((l) => l.account_number === '3960' || l.account_number === '7960')
  if (!fxLine) return 0
  return fxLine.account_number === '3960' ? fxLine.credit_amount : -fxLine.debit_amount
}
