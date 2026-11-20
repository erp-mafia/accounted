import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * A salary run's payment date is ahead when it falls after today's Swedish
 * calendar day. Booking such a run dates its vouchers, the bank leg included,
 * on a payout that has not happened yet (crm#1216), so the run page says so
 * before it posts.
 */
export function isPaymentDateAhead(
  paymentDate: string | null | undefined,
  today: string = todayIsoStockholm(),
): boolean {
  return typeof paymentDate === 'string' && paymentDate !== '' && paymentDate > today
}

/**
 * "Markera som betald" asks first when the payment date is ahead: the step
 * records that the net pay has left the bank, and Bokför then books it on the
 * payment date (crm#1216). It asks, it never refuses a confirmed step, since
 * some companies pay early on purpose (a payment file already scheduled in
 * the bank). A run with no payout has nothing to have paid: its step reads
 * "Fortsätt" and goes straight on.
 */
export function needsFuturePayoutConfirm(
  paymentDate: string | null | undefined,
  noPayout: boolean,
  today: string = todayIsoStockholm(),
): boolean {
  return !noPayout && isPaymentDateAhead(paymentDate, today)
}

export const PAYMENT_DATE_AHEAD_UNCONFIRMED = 'SALARY_RUN_PAYMENT_DATE_AHEAD_UNCONFIRMED' as const

export interface PaymentDateAheadRefusal {
  ok: false
  code: typeof PAYMENT_DATE_AHEAD_UNCONFIRMED
  details: { payment_date: string; today: string }
}

/**
 * The server-side half of the rule above, shared by every door that records
 * or posts a salary payout: the dashboard's paid and book routes, the v1
 * :mark-paid and :book verbs, and the MCP mark-paid and book tools. Marking a
 * run paid, or booking it (the net pay is credited to the bank account on the
 * payment date), before that date has come needs the caller's explicit
 * confirm_payment_date_ahead; without it the door refuses and nothing moves.
 * Confirmed, it goes through: the books carry a payout the company has
 * scheduled, and the bank row of that day later matches it. A hard refusal
 * would have stopped 69 of 151 past bookings in 54 of 95 payroll companies
 * with no other way to book (the net pay has no 2821 leg yet, issue #78).
 */
export function paymentDateAheadRefusal(
  run: { payment_date?: string | null; total_net?: number | null },
  confirmed: boolean | undefined,
  today: string = todayIsoStockholm(),
): PaymentDateAheadRefusal | null {
  if (confirmed === true) return null
  const noPayout = Math.round((run.total_net ?? 0) * 100) === 0
  if (!needsFuturePayoutConfirm(run.payment_date, noPayout, today)) return null
  return {
    ok: false,
    code: PAYMENT_DATE_AHEAD_UNCONFIRMED,
    details: { payment_date: run.payment_date as string, today },
  }
}
