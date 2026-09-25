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
import { RESIDUAL_MAX_AMOUNT } from '@/lib/reconciliation/residual'

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

export interface SupplierBankFeeSplit {
  /** Amount applied to the invoice, in the invoice's currency. */
  paymentAmount: number
  /** SEK that left the bank for the invoice part; null when unknown. */
  bankSek: number | null
  /** SEK booked as a bank fee (6570); 0 when the row does not overpay. */
  feeSek: number
}

/**
 * Split a same-currency bank row that pays MORE than the remaining balance into
 * the invoice part and a bank fee: the typical case is a card or transfer fee
 * added on top of the invoice (1 749,70 EUR drawn for a 1 739,43 EUR invoice).
 * The invoice then settles in full and the excess is booked on its own line
 * (addSupplierBankFeeLine) instead of the match being refused, or 2440 being
 * cleared by more than was owed.
 *
 * The excess is converted at the bank row's own rate when its SEK is known,
 * else at `invoiceRate`. Returned unchanged (feeSek 0) when the row does not
 * overpay past the same tolerance planSupplierPayment uses, when the fee's SEK
 * cannot be determined, or when it exceeds RESIDUAL_MAX_AMOUNT (the cap the
 * reconciliation residual uses: above it the excess is a missing booking, not
 * a fee), so planSupplierPayment still rejects those as an overshoot.
 */
export function splitSupplierBankFee(args: {
  /** Bank amount in the invoice's currency (same-currency match). */
  paymentAmount: number
  remaining: number
  /** SEK that left the bank for the whole row; null when unknown. */
  bankSek: number | null
  /** SEK per unit of the invoice currency (1 for SEK); null when unknown. */
  invoiceRate: number | null
  absorbOreRounding?: boolean
}): SupplierBankFeeSplit {
  const unchanged = { paymentAmount: args.paymentAmount, bankSek: args.bankSek, feeSek: 0 }
  const tolerance = args.absorbOreRounding ? ORE_ROUNDING_SETTLEMENT_MAX : ORE_TOLERANCE
  if (args.paymentAmount <= args.remaining + tolerance) return unchanged

  const excess = roundOre(args.paymentAmount - args.remaining)
  const feeSek =
    args.bankSek != null
      ? roundOre((args.bankSek * excess) / args.paymentAmount)
      : args.invoiceRate != null && args.invoiceRate > 0
        ? roundOre(excess * args.invoiceRate)
        : null
  if (feeSek == null || feeSek <= 0 || feeSek > RESIDUAL_MAX_AMOUNT) return unchanged

  return {
    paymentAmount: roundOre(args.remaining),
    bankSek: args.bankSek != null ? roundOre(args.bankSek - feeSek) : null,
    feeSek,
  }
}
