/**
 * The payment plan for matching ONE bank transaction to ONE customer invoice:
 * the FX resolution and the `planInvoicePayment` call (overshoot guard,
 * öresavrundning, paid/remaining/status) that the agent commit executor
 * (`commitMatchTransactionInvoice`) runs before it posts anything.
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
 * Read-only: the only side effect is the exchange-rate cache that
 * `fetchExchangeRate` maintains for a cross-currency match.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { isOverpaymentAccount, overpaymentAllowed } from '@/lib/bookkeeping/overpayment'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import {
  planInvoicePayment,
  type InvoicePaymentPlan,
  type InvoicePaymentTotals,
} from '@/lib/invoices/apply-invoice-payment'
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
  | { required: true; rate: number; paidInInvoiceCurrency: number }

/** An overshoot, in the invoice's currency. */
type OvershootDetails = { transaction_amount: number; remaining_amount: number; excess: number }

export type MatchPaymentStepResult =
  | {
      ok: true
      /** The payment in the INVOICE's currency, as accumulated into paid_amount. */
      paidAmount: number
      plan: InvoicePaymentPlan
      /** The excess booked on the caller's overpayment account, when any. */
      overpayment: { account: string; amount: number } | null
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
 */
export function planMatchPayment(
  invoice: MatchInvoiceAmounts,
  paidAmount: number,
  opts: { pureSek: boolean; overpaymentAccount?: string },
): MatchPaymentStepResult {
  const { pureSek } = opts
  const payment = planInvoicePayment(invoice, paidAmount, { absorbOreRounding: pureSek })
  if (payment.ok) return { ok: true, paidAmount, plan: payment.plan, overpayment: null }
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
      return { ok: true, paidAmount: remaining, plan: exact.plan, overpayment: { account, amount: excess } }
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

export async function planTransactionInvoiceMatch(
  supabase: SupabaseClient,
  transaction: MatchTransactionAmounts,
  invoice: MatchInvoiceAmounts,
  opts?: { overpaymentAccount?: string },
): Promise<MatchPaymentPlanResult> {
  // FX resolution: parity with the dashboard and v1 match routes. paidAmount
  // MUST be denominated in the INVOICE's currency (the unit of
  // invoices.paid_amount / remaining_amount and invoice_payments.amount).
  // Feeding the raw bank amount straight in (a) rejected exact whole-krona
  // settlements of öre-carrying invoices and (b) would corrupt the column
  // units on a cross-currency match.
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
    let rate: number | null = null
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
    if (rate == null) return { ok: false, code: 'MATCH_INVOICE_FX_RATE_UNAVAILABLE' }
    fx = {
      required: true,
      rate,
      paidInInvoiceCurrency: Math.round((txAbsSek / rate) * 10000) / 10000,
    }
  }
  const paidAmount = fx.required ? fx.paidInInvoiceCurrency : transaction.amount

  // Overshoot guard + paid/remaining math + a named overpayment account: the
  // one step the dashboard match route and its preview run too. Pure-SEK
  // settlements absorb sub-krona öresavrundning (booked to 3740 by the
  // builders) so a whole-krona payment settles in full.
  const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
  const step = planMatchPayment(invoice, paidAmount, { pureSek, overpaymentAccount: opts?.overpaymentAccount })
  return step.ok ? { ...step, fx } : step
}
