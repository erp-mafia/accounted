import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * A payment recorded by hand is dated the day the money moved, so never ahead
 * of today in Sweden: bokföring follows the real cash movement (BFL 5 kap 2 §),
 * and a payment booked ahead of its day is a scheduling note, not an
 * affärshändelse. Every door that records a payment by hand asks here, the
 * dialogs cap their date field by the same rule. A bank row's date is the
 * bank's fact and is not judged.
 */
export interface FuturePaymentDateRefusal {
  code: 'PAYMENT_DATE_IN_FUTURE'
  details: { field: 'payment_date'; attempted: string; today: string }
}

export function futurePaymentDateRefusal(
  paymentDate: string,
  today: string = todayIsoStockholm(),
): FuturePaymentDateRefusal | null {
  if (paymentDate <= today) return null
  return { code: 'PAYMENT_DATE_IN_FUTURE', details: { field: 'payment_date', attempted: paymentDate, today } }
}
