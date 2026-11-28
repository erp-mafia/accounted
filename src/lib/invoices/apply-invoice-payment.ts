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
import { roundOre, sumOre, equalOre, isZeroOre, ORE_TOLERANCE, ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { bookedOreRounding, oreSettlementResidual } from '@/lib/bookkeeping/ore-rounding'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { isCustomerReceivableAccount } from '@/lib/bookkeeping/customer-receivable-lines'

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

  // Within the öre band (and absorbing) → settle in full; the 3740 line carries
  // the residual. Covers both a short whole-krona payment and a rounded-up one.
  // The band is the one every payment builder books by (oreSettlementResidual),
  // so the plan never settles a gap the verifikat does not put on 3740. An
  // exact payment falls through to the plain path below, which settles it too.
  if (absorbOre && oreSettlementResidual(currentRemaining, paymentAmountInInvoiceCurrency) !== 0) {
    return {
      ok: true,
      plan: {
        newPaidAmount: roundOre((invoice.paid_amount || 0) + currentRemaining),
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
        oreSettled: true,
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

/** BAS 1513, Kundfordringar delad faktura: Skatteverket's ROT/RUT share. */
export const ROT_RUT_RECEIVABLE_ACCOUNT = '1513'

/**
 * Derives the customer-settlement amount from caller-supplied booking lines.
 *
 * `remaining_amount` on a ROT/RUT invoice is stored NET of the deduction
 * (total - deduction_total): the customer owes only their share, and
 * Skatteverket's share sits on 1513 until the payout-request flow clears it.
 * The kontantmetoden payment entry, however, correctly books TWO debit legs
 * (bank = customer share, 1513 = deduction), so a naive sum of all debits
 * yields the gross total and every ROT/RUT cash invoice fails the
 * overpayment guard by exactly the deduction.
 *
 * The 1513 exclusion is netted against 1513 credits (a debit/credit
 * correction pair in one entry must not shrink the settlement) and capped at
 * the invoice's own deduction, so on an invoice without a deduction the
 * result is the plain debit sum and behavior is unchanged, including the
 * rejection of a hand-added 1513 debit that overshoots the remaining.
 *
 * `deductionCapSek` must be in SEK (the lines' currency); the caller owns
 * converting a foreign-currency invoice's deduction_total.
 */
export function deriveCustomerSettlementAmount(
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>,
  deductionCapSek: number,
): number {
  const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0)
  if (deductionCapSek <= 0) return totalDebit
  const net1513 = roundOre(
    lines
      .filter((l) => l.account_number === ROT_RUT_RECEIVABLE_ACCOUNT)
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0),
  )
  const excluded = Math.min(Math.max(net1513, 0), deductionCapSek)
  return roundOre(totalDebit - excluded)
}

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
 *
 * `carriedSek` (carriedSekOf): when the issue verifikat already booked the
 * öresavrundning, the payment's 3740 carries only the rest of it (the
 * residual less bookedOreRounding), which is what the proposal books. For
 * that invoice the lines settle in full exactly when they clear what 1510
 * carries, the rule of the other settlement doors: whatever reached the bank,
 * 3740 takes the rest (999,75 paid where 1510 carries 1 000: Dr 1930 999,75,
 * Dr 3740 0,25, Cr 1510 1 000). Lines that would close the invoice with öre
 * left on 1510 (Cr 1510 999,75, the reskontra's figure) are refused with
 * INVOICE_PAID_ORE_LEFT; details.carried is the figure to clear.
 */
export function planInvoicePaymentForLines(
  invoice: InvoicePaymentTotals,
  paymentAmountInInvoiceCurrency: number,
  lines: PaymentLine[] | undefined,
  invoiceCurrency: string,
  carriedSek?: number | null,
): PlanInvoicePaymentForLinesResult {
  const absorbEligible = !!lines && isKronorCurrency(invoiceCurrency)
  const booked = absorbEligible ? bookedOreClearing(invoice, lines!, carriedSek) : null
  // The payment is the remainder, or off it by öresavrundning only: a krona
  // or more is planned as before (a part payment, or refused as too much).
  const paysRemainder =
    !!booked &&
    (equalOre(paymentAmountInInvoiceCurrency, booked.remaining) ||
      oreSettlementResidual(booked.remaining, paymentAmountInInvoiceCurrency) !== 0)
  // 3740 takes öresavrundning only: a krona or more there is not rounding,
  // and the old plan answers for it.
  const net3740 = booked ? net3740Of(lines!) : 0
  const roundingOnly = isZeroOre(net3740) || oreSettlementResidual(net3740, 0) !== 0
  if (booked && paysRemainder && roundingOnly && equalOre(booked.cleared, booked.carried)) {
    return {
      ok: true,
      plan: {
        newPaidAmount: roundOre((invoice.paid_amount || 0) + booked.remaining),
        newRemaining: 0,
        isFullyPaid: true,
        newStatus: 'paid',
        oreSettled: !equalOre(paymentAmountInInvoiceCurrency, booked.remaining),
      },
    }
  }

  const payment = planLinesPayment(invoice, paymentAmountInInvoiceCurrency, lines, absorbEligible, carriedSek)
  if (!payment.ok || !booked || payment.plan.newStatus !== 'paid') return payment
  const oreLeft = oreLeftByBookedOre(booked)
  return oreLeft ? { ok: false, code: 'INVOICE_PAID_ORE_LEFT', details: oreLeft } : payment
}

/**
 * What lines that settle a SEK customer invoice in full would leave on 1510,
 * for an invoice whose own verifikat booked the öresavrundning: the refusal
 * planInvoicePaymentForLines answers, for a door that plans the payment from
 * something other than the lines, as the bank match does from the bank row
 * (bookCustomerBankMatch). Null when the lines clear what 1510 carries, or
 * when 1510 carries the remainder.
 */
export function paidLinesOreLeft(
  invoice: InvoicePaymentTotals,
  lines: PaymentLine[],
  invoiceCurrency: string,
  carriedSek: number | null | undefined,
): { carried: number; cleared: number; left: number } | null {
  if (!isKronorCurrency(invoiceCurrency)) return null
  const booked = bookedOreClearing(invoice, lines, carriedSek)
  return booked ? oreLeftByBookedOre(booked) : null
}

function oreLeftByBookedOre(booked: { carried: number; cleared: number }): { carried: number; cleared: number; left: number } | null {
  const left = oreSettlementResidual(booked.carried, booked.cleared)
  return left === 0 ? null : { carried: booked.carried, cleared: booked.cleared, left }
}

type PaymentLine = { account_number: string; debit_amount: number; credit_amount: number }

export type PlanInvoicePaymentForLinesResult =
  | PlanInvoicePaymentResult
  | {
      ok: false
      code: 'INVOICE_PAID_ORE_LEFT'
      /** carried: what 1510 carries, the figure to clear; cleared: what the lines clear; left: what they would leave. */
      details: { carried: number; cleared: number; left: number }
    }

function planLinesPayment(
  invoice: InvoicePaymentTotals,
  paymentAmountInInvoiceCurrency: number,
  lines: PaymentLine[] | undefined,
  absorbEligible: boolean,
  carriedSek: number | null | undefined,
): PlanInvoicePaymentResult {
  const payment = planInvoicePayment(invoice, paymentAmountInInvoiceCurrency, {
    absorbOreRounding: absorbEligible,
  })
  if (!absorbEligible || !payment.ok || !payment.plan.oreSettled) return payment

  const currentRemaining =
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
  const residual = roundOre(
    oreSettlementResidual(currentRemaining, paymentAmountInInvoiceCurrency) -
      bookedOreRounding(roundOre(currentRemaining), carriedSek),
  )
  if (net3740Of(lines!) === residual) return payment
  return planInvoicePayment(invoice, paymentAmountInInvoiceCurrency)
}

/** The lines' net 3740, debit less credit. */
function net3740Of(lines: PaymentLine[]): number {
  return roundOre(
    lines
      .filter((l) => l.account_number === ORE_ROUNDING_ACCOUNT)
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0),
  )
}

/**
 * For a SEK invoice whose own verifikat booked the öresavrundning
 * (bookedOreRounding non-zero): what is still owed, what 1510 carries for it,
 * and what the lines clear, their net 151x credit. 1513 is Skatteverket's
 * ROT/RUT share, never what 1510 carries for the customer
 * (document_carried_sek leaves it out the same way). Null for every other
 * invoice: the lines are planned as they always were.
 */
function bookedOreClearing(
  invoice: InvoicePaymentTotals,
  lines: PaymentLine[],
  carriedSek: number | null | undefined,
): { remaining: number; carried: number; cleared: number } | null {
  const remaining = roundOre(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0))
  if (bookedOreRounding(remaining, carriedSek) === 0) return null
  const cleared = sumOre(
    lines
      .filter((l) => isCustomerReceivableAccount(l.account_number) && l.account_number !== ROT_RUT_RECEIVABLE_ACCOUNT)
      .map((l) => (Number(l.credit_amount) || 0) - (Number(l.debit_amount) || 0)),
  )
  return { remaining, carried: roundOre(carriedSek!), cleared }
}
