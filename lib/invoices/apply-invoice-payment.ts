/**
 * Single source of truth for applying a payment amount to a customer invoice.
 *
 * Computes the new paid/remaining/status and: critically: REJECTS overpayment
 * before the caller creates any journal entry, so a doomed match never burns a
 * voucher number.
 *
 * Background: this math was copy-pasted across three sites: the dashboard
 * match-invoice route (which had the overpayment guard), the v1 public API
 * route, and `commitMatchTransactionInvoice` (the agent/MCP path). The latter
 * two had drifted WITHOUT the guard, so they silently swallowed overpayment via
 * `Math.max(0, …)`: recording e.g. 1500 paid on a 1000 invoice and
 * over-crediting accounts receivable. Centralizing the math + guard here closes
 * that drift; all three sites delegate to `planInvoicePayment`.
 *
 * FX: `paymentAmountInInvoiceCurrency` MUST already be in the invoice's
 * currency. The caller owns any conversion (cross-currency settlement lives in
 * the dashboard route), keeping this helper FX-agnostic.
 *
 * Extracted from the proven dashboard route with the same half-öre overshoot
 * tolerance. Rounding goes through the canonical `roundOre` (@/lib/money) per
 * guard rail #9: identical to the route's previous `Math.round(x*100)/100`
 * except on exact-half-öre amounts, where `roundOre` rounds correctly.
 */
import { roundOre, ORE_TOLERANCE, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'

/** Half an öre: anything over the remaining by more than this is a real overpayment. */
export const PAYMENT_OVERSHOOT_TOLERANCE = ORE_TOLERANCE

export interface InvoicePaymentTotals {
  total: number
  paid_amount?: number | null
  remaining_amount?: number | null
}

export interface InvoicePaymentPlan {
  newPaidAmount: number
  newRemaining: number
  isFullyPaid: boolean
  newStatus: 'paid' | 'partially_paid'
  /** True when a sub-krona öre residual was absorbed (full settlement of an
   *  inexact amount): the 3740 line carries it. Always false unless the caller
   *  opts in via `absorbOreRounding`. */
  oreSettled: boolean
}

export type PlanInvoicePaymentResult =
  | { ok: true; plan: InvoicePaymentPlan }
  | {
      ok: false
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING'
      details: { transaction_amount: number; remaining_amount: number; excess: number }
    }

export function planInvoicePayment(
  invoice: InvoicePaymentTotals,
  paymentAmountInInvoiceCurrency: number,
  opts?: { absorbOreRounding?: boolean },
): PlanInvoicePaymentResult {
  const absorbOre = opts?.absorbOreRounding === true
  const currentRemaining =
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)

  // A rounded-up whole-krona payment is not an overpayment: when absorbing öre,
  // accept only an overshoot strictly inside the settlement band. The boundary
  // must be >= : with a strict > guard an exact 1 kr overshoot passed the guard
  // AND missed the |diff| < 1 absorb branch, falling through to record
  // paid_amount = total + 1 kr with remaining clamped to 0 (silent over-credit).
  // Without absorb, keep the strict half-öre float tolerance the legacy callers
  // rely on.
  const overshoot = roundOre(paymentAmountInInvoiceCurrency - currentRemaining)
  const isOverpayment = absorbOre
    ? overshoot >= ORE_ROUNDING_SETTLEMENT_MAX
    : paymentAmountInInvoiceCurrency > currentRemaining + PAYMENT_OVERSHOOT_TOLERANCE
  if (isOverpayment) {
    return {
      ok: false,
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING',
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
    return {
      ok: true,
      plan: {
        newPaidAmount: roundOre((invoice.paid_amount || 0) + currentRemaining),
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
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

/** BAS öres- och kronutjämning: the only account that may carry an absorbed residual. */
const ORE_ROUNDING_ACCOUNT = '3740'

/**
 * `planInvoicePayment` for caller-supplied booking lines (the mark-paid
 * dialog and the v1 API), where the server does NOT build the verifikat.
 *
 * Absorbing an öre residual is only safe when the lines actually book it:
 * in the server-built bank-match flow `buildInvoicePaymentClearingLines`
 * guarantees 1510 is credited the full remaining and 3740 carries the exact
 * residual, so plan and GL absorb together. Here the lines are caller-owned,
 * so absorption is granted only when the net 3740 amount (debit − credit)
 * equals the signed residual (remaining − payment). Otherwise fall back to
 * the strict plan: a sub-krona short payment stays a real partial and a
 * sub-krona overshoot is rejected, exactly as before absorption existed.
 * Without this gate an invoice could flip to paid while the posted lines
 * under-clear 1510, diverging the GL from the AR sub-ledger.
 */
export function planInvoicePaymentForLines(
  invoice: InvoicePaymentTotals,
  paymentAmountInInvoiceCurrency: number,
  lines:
    | Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    | undefined,
  invoiceCurrency: string,
): PlanInvoicePaymentResult {
  const absorbEligible = !!lines && invoiceCurrency === 'SEK'
  const payment = planInvoicePayment(invoice, paymentAmountInInvoiceCurrency, {
    absorbOreRounding: absorbEligible,
  })
  if (!absorbEligible || !payment.ok || !payment.plan.oreSettled) return payment

  const currentRemaining =
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
  const residual = roundOre(currentRemaining - paymentAmountInInvoiceCurrency)
  const net3740 = roundOre(
    lines!
      .filter((l) => l.account_number === ORE_ROUNDING_ACCOUNT)
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0),
  )
  if (net3740 === residual) return payment
  return planInvoicePayment(invoice, paymentAmountInInvoiceCurrency)
}
