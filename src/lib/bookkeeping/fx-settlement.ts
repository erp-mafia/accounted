/**
 * How far a kronor figure may sit from a foreign document and still be its
 * settlement.
 *
 * A EUR invoice paid in full reaches or leaves a SEK account at the bank's
 * rate, never at Riksbanken's mid rate. Read at the mid rate of the payment
 * day, the converted figure tells a full payment from a part of it. Every door
 * that knows the payment-day rate reads the answer here; each used to carry its
 * own, so 1000 EUR remaining and a row of 5 700 kr (half at 11.40) was a part
 * payment on the customer match and a settled invoice with a kursvinst of
 * 5 700 kr on the supplier match.
 *
 * Inside the band the payment settles the whole remainder: 1510 or 2440 clears
 * what it carries and the difference to the SEK that moved is the realised
 * kursvinst (3960) or kursförlust (7960).
 *
 * The SQL doors (match_batch_allocate, link_invoice_to_voucher,
 * link_supplier_invoice_to_voucher) have no payment-day rate and settle in
 * full or not at all, so they read fxDeviationTooLarge against the booked SEK:
 * a limit on what can be this document at all, wide enough for the rate to
 * have moved since it was booked. public.fx_deviation_too_large is its side in
 * SQL, pinned at the edge by tests/pg/fx-settlement-doors.pg.test.ts.
 */
import { roundOre } from '@/lib/money'

/**
 * How close a payment must come to the remainder to settle it, at the
 * payment-day mid rate: 2 % (decision 2026-10-28, PH 227). The spread and the
 * transfer fee left a full customer payment 0.5 to 1.7 % short in production,
 * and every one of the 17 foreign customer matches in production sits within
 * 0.9 %.
 */
export const FX_FULL_SETTLEMENT_BAND = 0.02

/**
 * How far a figure may sit from the SEK booked and still be this document at
 * another rate. Outside it the figure is the wrong document (1 000 kr against a
 * 1 000 EUR remainder), a rättelse of the debt, or a mistyped amount, and
 * booking the gap on 3960/7960 would call it a kursdifferens.
 */
export const FX_SAME_DOCUMENT_LIMIT = 0.1

/**
 * The bank's cut runs against whoever moves the money: a receipt arrives short,
 * a payment leaves over. So paying more kronor than the mid rate says is what a
 * full supplier payment looks like (a card rate: 36 of 57 foreign supplier
 * matches in the last 90 days sat 2 to 8.8 % over it, and none past the limit),
 * while receiving more is a customer who paid too much.
 */
const OVER_REMAINDER_LIMIT = { customer: FX_FULL_SETTLEMENT_BAND, supplier: FX_SAME_DOCUMENT_LIMIT } as const

/** Which ledger the payment clears: it decides which way the bank's cut runs. */
export type FxSettlementSide = keyof typeof OVER_REMAINDER_LIMIT

export interface FxSettlement {
  /**
   * settles  the whole remainder.
   * partial  short of the band: a part payment of `paidInInvoiceCurrency`.
   * refused  above what the remainder can explain: no invoice owed this.
   */
  outcome: 'settles' | 'partial' | 'refused'
  /** The payment in the invoice's currency: the remainder when it settles, else kronor / rate to four decimals. */
  paidInInvoiceCurrency: number
}

/**
 * What `sekPaid` does to a foreign document that has `remaining` left, at the
 * payment-day `rate`. Pure. A SEK invoice paid from a foreign account reads
 * the same at rate 1.
 */
export function fxSettlementOutcome(
  sekPaid: number,
  rate: number,
  remaining: number,
  side: FxSettlementSide,
): FxSettlement {
  const converted = Math.round((sekPaid / rate) * 10000) / 10000
  const gap = converted - remaining
  if (remaining <= 0 || gap > remaining * OVER_REMAINDER_LIMIT[side]) {
    return { outcome: 'refused', paidInInvoiceCurrency: converted }
  }
  if (-gap > remaining * FX_FULL_SETTLEMENT_BAND) {
    return { outcome: 'partial', paidInInvoiceCurrency: converted }
  }
  return { outcome: 'settles', paidInInvoiceCurrency: remaining }
}

function toOre(sek: number): number {
  return Math.round(roundOre(sek) * 100)
}

/**
 * Whether a SEK figure is too far from the SEK booked to be this document at
 * another rate. Counted in whole öre, so the edge answers what numeric answers
 * in public.fx_deviation_too_large.
 */
export function fxDeviationTooLarge(sek: number, bookedSek: number): boolean {
  return toOre(Math.abs(sek - bookedSek)) > Math.abs(toOre(bookedSek)) * FX_SAME_DOCUMENT_LIMIT
}
