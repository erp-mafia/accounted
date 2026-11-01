/**
 * The payment plan for matching ONE bank transaction to ONE customer invoice:
 * the FX resolution and the `planInvoicePayment` call (overshoot guard,
 * öresavrundning, paid/remaining/status) that bookCustomerBankMatch runs
 * before it posts anything.
 *
 * Shared with the MCP tools that STAGE that operation, so a match the approval
 * would refuse is refused when it is staged, from the same inputs: the
 * transaction and invoice currencies, the pure-SEK öre absorption, and the
 * invoice's remaining amount after any partial payments already applied.
 * Before this, staging validated invoice state only and an overpaid match was
 * accepted, then rejected at approval (crm#253).
 *
 * An overshoot of a krona or more is refused unless the caller names where
 * the excess goes (`overpaymentAccount`, pure SEK only, see
 * lib/bookkeeping/overpayment.ts): then the invoice settles for exactly its
 * remaining amount and `overpayment` carries the excess the verifikat books
 * on that account. That step, after FX, is `planMatchPayment`, which the
 * dashboard match route and its preview run too (crm#1045).
 *
 * The mirror: a SEK bank row a krona or more SHORT of the remaining amount is
 * a partial payment unless the caller names `feeAccount` (6570, see
 * lib/bookkeeping/payment-fee.ts): the payment provider's fee withheld from
 * its payout. Then the invoice settles in full and `fee` carries the
 * shortfall the verifikat books on that account (crm#1364).
 *
 * Read-only: the only side effect is the exchange-rate cache that
 * `fetchExchangeRate` maintains for a cross-currency match.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { isOverpaymentAccount, overpaymentAllowed } from '@/lib/bookkeeping/overpayment'
import { isPaymentFeeAccount, paymentFeeAllowed, paymentFeeShortfall } from '@/lib/bookkeeping/payment-fee'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import {
  planInvoicePayment,
  type InvoicePaymentPlan,
  type InvoicePaymentTotals,
} from '@/lib/invoices/apply-invoice-payment'
import { roundOre } from '@/lib/money'
import type { Currency } from '@/types'

export interface MatchTransactionAmounts {
  amount: number
  amount_sek?: number | null
  currency: string | null
  exchange_rate?: number | null
  /** Payment date (YYYY-MM-DD): the cross-currency rate is read for it. */
  date: string
}

export interface MatchInvoiceAmounts extends InvoicePaymentTotals {
  currency: string
}

export type MatchFx =
  | { required: false }
  | {
      required: true
      rate: number
      paidInInvoiceCurrency: number
      /**
       * Provenance of the rate: 'manual' = caller-supplied from a bank
       * statement (Riksbanken had no rate for the date), 'riksbanken' = spot
       * rate on the payment date. A manual override on a money path must be
       * traceable (BFL 5 kap 6-7 §; ML 8 kap 21-23 §).
       */
      source: 'manual' | 'riksbanken'
    }

/** An overshoot, in the invoice's currency. */
type OvershootDetails = { transaction_amount: number; remaining_amount: number; excess: number }

/** A shortfall the caller named as a payment provider's fee, in the invoice's currency. */
type ShortfallDetails = {
  transaction_amount: number
  remaining_amount: number
  shortfall: number
  /** 'currency': not a pure SEK match; 'cap': PAYMENT_FEE_MAX_PERCENT or more of the remaining. */
  reason: 'currency' | 'cap'
}

export type MatchPaymentStepResult =
  | {
      ok: true
      /** The payment in the INVOICE's currency, as accumulated into paid_amount. */
      paidAmount: number
      plan: InvoicePaymentPlan
      /** The excess booked on the caller's overpayment account, when any. */
      overpayment: { account: string; amount: number } | null
      /** The shortfall booked on the caller's payment fee account, when any. */
      fee: { account: string; amount: number } | null
    }
  | {
      ok: false
      code: 'MATCH_AMOUNT_EXCEEDS_REMAINING'
      /** Currency of the amounts in `details` (the invoice's). */
      currency: string
      /** True when a sub-krona overshoot would have been absorbed (pure SEK). */
      absorbsOre: boolean
      details: OvershootDetails
    }
  /** overpaymentAccount 3740 named for an excess at or above its cap. */
  | {
      ok: false
      code: 'MATCH_OVERPAYMENT_ROUNDING_CAP'
      currency: string
      details: OvershootDetails
    }
  /** feeAccount named for a shortfall no fee can be: cross-currency, or at or above its cap. */
  | {
      ok: false
      code: 'MATCH_PAYMENT_FEE_NOT_ALLOWED'
      currency: string
      details: ShortfallDetails
    }

export type MatchPaymentPlanResult =
  | (Extract<MatchPaymentStepResult, { ok: true }> & { fx: MatchFx })
  /** A foreign-currency transaction with neither amount_sek nor a rate. */
  | { ok: false; code: 'MATCH_INVOICE_TX_FX_RATE_MISSING' }
  /** No exchange rate for the payment date (not published yet, or upstream down). */
  | { ok: false; code: 'MATCH_INVOICE_FX_RATE_UNAVAILABLE' }
  | Extract<MatchPaymentStepResult, { ok: false }>

/**
 * The payment step of a match once the payment is in the invoice's currency:
 * planInvoicePayment's overshoot guard and paid/remaining math (pure SEK
 * absorbs a sub-krona öresavrundning), and for an overshoot of a krona or more
 * the settlement at exactly the remaining amount when the caller named an
 * account allowed to take the excess. Pure. The agent stage and commit paths,
 * the dashboard match route and its preview all run this one step, so the
 * preview cannot show a booking the route refuses (crm#1045).
 *
 * `feeAccount`: a payment that falls short of the remaining amount settles it
 * in full when the caller names the account for the payment provider's fee,
 * pure SEK only and under its cap (payment-fee.ts); otherwise the named
 * account is refused rather than quietly booking a partial payment the
 * caller did not ask for (crm#1364). Unused when the payment settles anyway.
 */
export function planMatchPayment(
  invoice: MatchInvoiceAmounts,
  paidAmount: number,
  opts: { pureSek: boolean; overpaymentAccount?: string; feeAccount?: string },
): MatchPaymentStepResult {
  const { pureSek } = opts
  const payment = planInvoicePayment(invoice, paidAmount, { absorbOreRounding: pureSek })
  if (payment.ok) {
    const feeAccount = opts.feeAccount
    if (!isPaymentFeeAccount(feeAccount) || payment.plan.isFullyPaid) {
      return { ok: true, paidAmount, plan: payment.plan, overpayment: null, fee: null }
    }
    const remaining = roundOre(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0))
    const shortfall = roundOre(remaining - paidAmount)
    const details = { transaction_amount: paidAmount, remaining_amount: remaining, shortfall }
    if (!pureSek) {
      return {
        ok: false,
        code: 'MATCH_PAYMENT_FEE_NOT_ALLOWED',
        currency: invoice.currency,
        details: { ...details, reason: 'currency' },
      }
    }
    const fee = paymentFeeShortfall(remaining, paidAmount)
    if (fee === 0 || !paymentFeeAllowed(feeAccount, fee, remaining)) {
      return {
        ok: false,
        code: 'MATCH_PAYMENT_FEE_NOT_ALLOWED',
        currency: invoice.currency,
        details: { ...details, reason: 'cap' },
      }
    }
    // Exactly the remaining amount: planInvoicePayment settles it in full.
    const settled = planInvoicePayment(invoice, remaining, { absorbOreRounding: true })
    if (settled.ok) {
      return {
        ok: true,
        paidAmount: remaining,
        plan: settled.plan,
        overpayment: null,
        fee: { account: feeAccount, amount: fee },
      }
    }
    return { ok: true, paidAmount, plan: payment.plan, overpayment: null, fee: null }
  }
  // The user named where the excess goes: settle exactly the remaining
  // amount and hand the excess to the verifikat builders. Pure SEK only: a
  // cross-currency excess has no SEK amount the user agreed to.
  const account = opts.overpaymentAccount
  if (pureSek && isOverpaymentAccount(account)) {
    const { excess, remaining_amount: remaining } = payment.details
    if (!overpaymentAllowed(account, excess)) {
      return {
        ok: false,
        code: 'MATCH_OVERPAYMENT_ROUNDING_CAP',
        currency: invoice.currency,
        details: payment.details,
      }
    }
    const exact = planInvoicePayment(invoice, remaining, { absorbOreRounding: true })
    if (exact.ok) {
      return { ok: true, paidAmount: remaining, plan: exact.plan, overpayment: { account, amount: excess }, fee: null }
    }
  }
  return {
    ok: false,
    code: payment.code,
    currency: invoice.currency,
    absorbsOre: pureSek,
    details: payment.details,
  }
}

/**
 * How close a cross-currency payment must come to the invoice's remaining
 * amount to settle it in full: 2 % either way, in the invoice's currency.
 *
 * A EUR invoice paid in full reaches a SEK account converted at the bank's
 * rate, never at Riksbanken's mid rate: the spread and the transfer fee leave
 * the converted figure a little short (0.5 to 1.7 % on the payments matched in
 * production). Read at the mid rate, that payment was booked as a partial
 * payment, the invoice stayed open for the residual and the kursdifferens
 * landed on the wrong side (PH 227). Within the band the payment settles the
 * whole remaining: 1510 is credited at the invoice's booking rate and the
 * difference to the SEK received is the realised kursvinst (3960) or
 * kursförlust (7960). Outside it the payment stays a partial payment.
 */
export const FX_FULL_SETTLEMENT_BAND = 0.02

/**
 * A SEK payment of a foreign-currency invoice, in the invoice's currency:
 * `sek / rate`, to four decimals, or exactly the remaining amount when that
 * figure lies inside FX_FULL_SETTLEMENT_BAND of it (see there). Pure. Every
 * match door (dashboard route and its preview, the v1 route, the agent
 * stage and commit) converts through this one function, so the preview the
 * user approves is the booking the route makes.
 */
export function fxPaidInInvoiceCurrency(
  sekAmount: number,
  rate: number,
  invoice: InvoicePaymentTotals,
): number {
  const converted = Math.round((sekAmount / rate) * 10000) / 10000
  const remaining = roundOre(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0))
  if (remaining > 0 && Math.abs(converted - remaining) <= remaining * FX_FULL_SETTLEMENT_BAND) {
    return remaining
  }
  return converted
}

export async function planTransactionInvoiceMatch(
  supabase: SupabaseClient,
  transaction: MatchTransactionAmounts,
  invoice: MatchInvoiceAmounts,
  opts?: { overpaymentAccount?: string; feeAccount?: string; manualExchangeRate?: number },
): Promise<MatchPaymentPlanResult> {
  // FX resolution. paidAmount MUST be denominated in the INVOICE's currency
  // (the unit of invoices.paid_amount / remaining_amount and
  // invoice_payments.amount). Feeding the raw bank amount straight in (a)
  // rejected exact whole-krona settlements of öre-carrying invoices and (b)
  // would corrupt the column units on a cross-currency match.
  const txIsForeign = !!transaction.currency && transaction.currency !== 'SEK'
  if (
    txIsForeign &&
    transaction.amount_sek == null &&
    !(transaction.exchange_rate != null && transaction.exchange_rate > 0)
  ) {
    return { ok: false, code: 'MATCH_INVOICE_TX_FX_RATE_MISSING' }
  }
  const txAbsSek =
    Math.round(
      resolveSekAmount(
        Math.abs(transaction.amount),
        transaction.amount_sek != null ? Math.abs(transaction.amount_sek) : null,
        transaction.currency,
        transaction.exchange_rate,
      ) * 100,
    ) / 100

  let fx: MatchFx = { required: false }
  if (transaction.currency !== invoice.currency) {
    const manualRate = opts?.manualExchangeRate && opts.manualExchangeRate > 0 ? opts.manualExchangeRate : null
    let rate = manualRate
    if (rate == null) {
      try {
        const rateInfo = await fetchExchangeRate(
          invoice.currency as Currency,
          new Date(transaction.date),
          supabase,
        )
        if (rateInfo && rateInfo.rate > 0) rate = rateInfo.rate
      } catch {
        rate = null
      }
    }
    if (rate == null) return { ok: false, code: 'MATCH_INVOICE_FX_RATE_UNAVAILABLE' }
    fx = {
      required: true,
      rate,
      paidInInvoiceCurrency: fxPaidInInvoiceCurrency(txAbsSek, rate, invoice),
      source: manualRate != null ? 'manual' : 'riksbanken',
    }
  }
  const paidAmount = fx.required ? fx.paidInInvoiceCurrency : transaction.amount

  // Overshoot guard + paid/remaining math + a named overpayment account: the
  // one step the dashboard match route and its preview run too. Pure-SEK
  // settlements absorb sub-krona öresavrundning (booked to 3740 by the
  // builders) so a whole-krona payment settles in full.
  const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
  const step = planMatchPayment(invoice, paidAmount, {
    pureSek,
    overpaymentAccount: opts?.overpaymentAccount,
    feeAccount: opts?.feeAccount,
  })
  return step.ok ? { ...step, fx } : step
}
