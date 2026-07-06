/**
 * Single source of truth for applying a payment amount to a SUPPLIER invoice:
 * the supplier-side mirror of `planInvoicePayment` (@/lib/invoices/apply-invoice-payment).
 *
 * Computes the new paid/remaining/status and REJECTS overpayment before the
 * caller creates any journal entry, so a doomed match never burns a voucher
 * number. The supplier match route previously inlined this math (and its
 * overshoot guard) directly; centralizing it keeps the two off-by-one tolerances
 * (overshoot vs öre absorption) honest and unit-testable without a DB.
 *
 * # Öresavrundning (opt-in)
 *
 * When `absorbOreRounding` is set (callers pass it only for same-currency SEK
 * settlements), a payment within `ORE_ROUNDING_SETTLEMENT_MAX` of the remaining
 * (short or over) settles the invoice IN FULL; the residual is booked to BAS
 * 3740 by the line builder (`buildSupplierPaymentClearingLines`). Without the
 * flag the behaviour is the strict legacy one (half-öre overshoot tolerance,
 * any real shortfall left as a partial), preserving every other caller.
 *
 * FX: `paymentAmountInInvoiceCurrency` MUST already be in the invoice's currency.
 * The caller owns any conversion, keeping this helper FX-agnostic.
 */
import { roundOre, ORE_TOLERANCE, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'

export interface SupplierPaymentTotals {
  total: number
  paid_amount?: number | null
  remaining_amount?: number | null
}

export interface SupplierPaymentPlan {
  newPaidAmount: number
  newRemaining: number
  isFullyPaid: boolean
  newStatus: 'paid' | 'partially_paid'
  /** True when an öre residual was absorbed (full settlement of an inexact
   *  amount). Lets callers/tests assert the 3740 path without re-deriving it. */
  oreSettled: boolean
}

export type PlanSupplierPaymentResult =
  | { ok: true; plan: SupplierPaymentPlan }
  | {
      ok: false
      code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING'
      details: { transaction_amount: number; remaining_amount: number; excess: number }
    }

export function planSupplierPayment(
  invoice: SupplierPaymentTotals,
  paymentAmountInInvoiceCurrency: number,
  opts?: { absorbOreRounding?: boolean },
): PlanSupplierPaymentResult {
  const absorbOre = opts?.absorbOreRounding === true
  const currentRemaining =
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)

  // Overpayment past the tolerated band is a real overshoot → reject. With öre
  // absorption the band is one krona (a rounded-up whole-krona payment is not an
  // overpayment); otherwise it's the strict half-öre float tolerance.
  const overshootTolerance = absorbOre ? ORE_ROUNDING_SETTLEMENT_MAX : ORE_TOLERANCE
  if (paymentAmountInInvoiceCurrency > currentRemaining + overshootTolerance) {
    return {
      ok: false,
      code: 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING',
      details: {
        transaction_amount: paymentAmountInInvoiceCurrency,
        remaining_amount: roundOre(currentRemaining),
        excess: roundOre(paymentAmountInInvoiceCurrency - currentRemaining),
      },
    }
  }

  const diff = roundOre(currentRemaining - paymentAmountInInvoiceCurrency)

  // Within the öre band (and absorbing) → settle in full; the 3740 line carries
  // the residual. Covers both a short whole-krona payment and a rounded-up one.
  if (absorbOre && Math.abs(diff) < ORE_ROUNDING_SETTLEMENT_MAX) {
    const newPaidAmount = roundOre((invoice.paid_amount || 0) + currentRemaining)
    return {
      ok: true,
      plan: {
        newPaidAmount,
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
        // Only flag öre settlement when there is an actual residual to book:
        // an exact payment needs no 3740 line.
        oreSettled: Math.abs(diff) >= ORE_TOLERANCE,
      },
    }
  }

  const newPaidAmount = roundOre((invoice.paid_amount || 0) + paymentAmountInInvoiceCurrency)
  const newRemaining = Math.max(0, roundOre(currentRemaining - paymentAmountInInvoiceCurrency))
  const isFullyPaid = newRemaining <= 0

  return {
    ok: true,
    plan: {
      newPaidAmount,
      newRemaining,
      isFullyPaid,
      newStatus: isFullyPaid ? 'paid' : 'partially_paid',
      oreSettled: false,
    },
  }
}
