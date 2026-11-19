/**
 * Amounts for invoice reminders. The automatic reminder sender, its cron and
 * its email templates were removed (Plan 2 step 18): sending had been off since
 * May 2026 (#583) and reminders belong to the collections integration. What
 * stays is the amount split the public reminder action page
 * (/api/invoices/reminders/action) shows for reminders already sent.
 */

/**
 * The lagstadgad påminnelseavgift is a Swedish-krona statute: Lag (1981:739) om
 * ersättning för inkassokostnader m.m. 2 §, with the amount fixed at 60 kr by
 * förordning (1981:1057) 1 §. There is no conversion rule for a foreign-currency
 * claim, and the reminder sender booked the fee 1510/3990 in SEK regardless of
 * the invoice currency.
 *
 * So the fee is always quoted in SEK. Rendering "60" with the invoice's currency
 * code would demand roughly ten times the statutory amount from a EUR customer
 * and would not match the receivable recorded in the books.
 */
export const REMINDER_FEE_CURRENCY = 'SEK'

export interface ReminderAmounts {
  /** Invoice currency (uppercased ISO code). Carries the invoice total + interest. */
  currency: string
  /** invoice.total + dröjsmålsränta, plus the fee only when the invoice is itself in SEK. */
  totalDue: number
  /**
   * The påminnelseavgift in SEK when the invoice is in another currency, so it
   * has to be demanded alongside rather than inside `totalDue`. 0 when the fee
   * is already folded into `totalDue`.
   */
  feeDueSeparately: number
}

/**
 * Split the amount to pay per currency. Never returns a single scalar that mixes
 * a foreign invoice currency with the SEK statutory fee.
 */
export function calculateReminderAmounts(input: {
  invoiceTotal: number
  interestAmount: number
  reminderFee: number
  currency?: string | null
}): ReminderAmounts {
  const currency = (input.currency || REMINDER_FEE_CURRENCY).toUpperCase()
  const feeSharesInvoiceCurrency = currency === REMINDER_FEE_CURRENCY
  const fee = input.reminderFee > 0 ? Math.round(input.reminderFee * 100) / 100 : 0

  const totalDue =
    Math.round(
      (input.invoiceTotal + input.interestAmount + (feeSharesInvoiceCurrency ? fee : 0)) * 100,
    ) / 100

  return {
    currency,
    totalDue,
    feeDueSeparately: feeSharesInvoiceCurrency ? 0 : fee,
  }
}
