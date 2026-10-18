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
 * payment date (crm#1216). It asks, it never refuses, since some companies
 * pay early on purpose. A run with no payout has nothing to have paid: its
 * step reads "Fortsätt" and goes straight on.
 */
export function needsFuturePayoutConfirm(
  paymentDate: string | null | undefined,
  noPayout: boolean,
  today: string = todayIsoStockholm(),
): boolean {
  return !noPayout && isPaymentDateAhead(paymentDate, today)
}
