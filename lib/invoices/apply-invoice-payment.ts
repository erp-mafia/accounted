/**
 * Single source of truth for applying a payment amount to a customer invoice.
 *
 * Computes the new paid/remaining/status and — critically — REJECTS overpayment
 * before the caller creates any journal entry, so a doomed match never burns a
 * voucher number.
 *
 * Background: this math was copy-pasted across three sites — the dashboard
 * match-invoice route (which had the overpayment guard), the v1 public API
 * route, and `commitMatchTransactionInvoice` (the agent/MCP path). The latter
 * two had drifted WITHOUT the guard, so they silently swallowed overpayment via
 * `Math.max(0, …)` — recording e.g. 1500 paid on a 1000 invoice and
 * over-crediting accounts receivable. Centralizing the math + guard here closes
 * that drift; all three sites delegate to `planInvoicePayment`.
 *
 * FX: `paymentAmountInInvoiceCurrency` MUST already be in the invoice's
 * currency. The caller owns any conversion (cross-currency settlement lives in
 * the dashboard route), keeping this helper FX-agnostic.
 *
 * Extracted from the proven dashboard route with the same half-öre overshoot
 * tolerance. Rounding goes through the canonical `roundOre` (@/lib/money) per
 * guard rail #9 — identical to the route's previous `Math.round(x*100)/100`
 * except on exact-half-öre amounts, where `roundOre` rounds correctly.
 */
import { roundOre, ORE_TOLERANCE } from '@/lib/money'

/** Half an öre — anything over the remaining by more than this is a real overpayment. */
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
): PlanInvoicePaymentResult {
  const currentRemaining =
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)

  if (paymentAmountInInvoiceCurrency > currentRemaining + PAYMENT_OVERSHOOT_TOLERANCE) {
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
    },
  }
}
