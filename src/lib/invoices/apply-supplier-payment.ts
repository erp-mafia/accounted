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
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'

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
  // overpayment); otherwise it's the strict half-öre float tolerance. The öre
  // band is open at one krona (the settlement below and supplierOreResidual
  // absorb only a residual strictly under it), so an excess of exactly one
  // krona is refused too: accepting it as a partial would push paid_amount
  // past the total with no 3740 line to carry the krona.
  const overshoots = absorbOre
    ? roundOre(paymentAmountInInvoiceCurrency - currentRemaining) >= ORE_ROUNDING_SETTLEMENT_MAX
    : paymentAmountInInvoiceCurrency > currentRemaining + ORE_TOLERANCE
  if (overshoots) {
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
  const excess = roundOre(args.paymentAmount - args.remaining)
  // With öre absorption the band is open at one krona, exactly where
  // planSupplierPayment and supplierOreResidual draw it: an excess strictly
  // under a krona is öresavrundning (3740), one of a krona or more is a fee.
  // A closed band here would leave an excess of exactly one krona booked as
  // neither, with 1930 a krona short of the bank row.
  const withinTolerance = args.absorbOreRounding
    ? excess < ORE_ROUNDING_SETTLEMENT_MAX
    : args.paymentAmount <= args.remaining + ORE_TOLERANCE
  if (withinTolerance) return unchanged

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

/** The supplier_invoices fields planSupplierBankMatch reads. */
export interface SupplierBankMatchInvoice extends SupplierPaymentTotals {
  currency: string
  exchange_rate?: number | null
  /** Set when 2440 was posted at receipt (faktureringsmetoden). */
  registration_journal_entry_id?: string | null
}

/** The transactions fields planSupplierBankMatch reads. */
export interface SupplierBankMatchTransaction {
  /** Negative: an expense row. */
  amount: number
  currency: string
  amount_sek?: number | null
}

/**
 * Which generator books the payment verifikat, with its exact inputs. Every
 * door hands these to the same generator (createSupplierBankMatchEntry) or,
 * for the preview, to its pure line builder (buildSupplierBankMatchLines).
 *
 *   cash      kontantmetoden, the invoice was never booked: expense + VAT at
 *             payment (createSupplierInvoiceCashEntry). `settledBankSek` is
 *             the SEK that left the bank for the invoice part.
 *   clearing  faktureringsmetoden: Dr 2440 / Cr the payment account
 *             (createSupplierInvoicePaymentEntry). Pure SEK carries
 *             `sekClearingDebt` (3740 öresavrundning); a foreign leg carries
 *             the booked SEK and any kursdifferens.
 *
 * `bankFeeSek` (splitSupplierBankFee) is booked on 6570 by either builder.
 */
export type SupplierBankMatchBooking =
  | { kind: 'cash'; settledBankSek?: number; bankFeeSek: number }
  | {
      kind: 'clearing'
      paymentAmount: number
      exchangeRateDifference?: number
      sekClearingDebt?: number
      bankFeeSek: number
    }

export interface SupplierBankMatchPlan extends SupplierPaymentPlan {
  /**
   * The debt this payment settles, in the invoice's currency: the
   * supplier_invoice_payments amount (newPaidAmount minus what was already
   * paid). It is the debt, not the cash: an absorbed öre residual (3740) is
   * part of it, a bank fee (6570) is not.
   */
  settledAmount: number
  /** SEK booked on 6570; 0 when the row does not pay more than is owed. */
  bankFeeSek: number
  booking: SupplierBankMatchBooking
}

export type SupplierBankMatchRefusalCode =
  | 'MATCH_SI_AMOUNT_EXCEEDS_REMAINING'
  | 'SI_FX_RATE_MISSING'
  | 'MATCH_SI_CASH_FX_UNSUPPORTED'
  | 'SI_CASH_PARTIAL_UNSUPPORTED'

export type PlanSupplierBankMatchResult =
  | { ok: true; plan: SupplierBankMatchPlan }
  | { ok: false; code: SupplierBankMatchRefusalCode; details: Record<string, unknown> }

/**
 * The whole payment plan of matching one bank row to one supplier invoice:
 * the bank fee split, the overshoot guard, öresavrundning, the SEK and
 * kursdifferens resolution, the kontantmetoden refusals, the ledger update and
 * the generator inputs. Pure, and it refuses up front what the generator would
 * otherwise refuse mid-booking (a missing rate included), so the plan's
 * refusals happen before any write: no voucher number is burnt and no prior
 * categorisation is reversed.
 *
 * Every door that matches a bank row to a supplier invoice (the dashboard
 * POST, its preview and the v1 POST) plans through this function. Each used
 * to carry its own copy, and the rules added later (öresavrundning, the fee on
 * 6570) reached only the copies their authors touched: the v1 door cleared the
 * whole bank row off 2440 with no fee line, no 3740 line and no overshoot
 * guard, so an overpayment pushed paid_amount past the invoice total.
 */
export function planSupplierBankMatch(args: {
  invoice: SupplierBankMatchInvoice
  transaction: SupplierBankMatchTransaction
  accountingMethod: string | null | undefined
}): PlanSupplierBankMatchResult {
  const { invoice, transaction } = args
  const accountingMethod = args.accountingMethod || 'accrual'
  const txAmountAbs = Math.abs(transaction.amount)
  const remaining = invoice.remaining_amount ?? roundOre(invoice.total - (invoice.paid_amount || 0))
  const sameCurrency = transaction.currency === invoice.currency

  // Pure SEK settlements clear through the SEK clearing builder so öre
  // rounding lands on 3740 and the invoice settles in full; foreign legs keep
  // the kursvinst/kursförlust path.
  const isPureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'

  // SEK that left the bank for the whole row, when known: a SEK row's absolute
  // amount, a foreign row's stored amount_sek, else unknown (null). The raw
  // foreign amount must never stand in: treating 19 USD as 19 SEK books
  // "19 kr" on a ~175 kr payment.
  const bankSekRow =
    transaction.currency === 'SEK'
      ? txAmountAbs
      : transaction.amount_sek != null
        ? Math.abs(transaction.amount_sek)
        : null

  // A same-currency row that pays MORE than the remaining balance (the invoice
  // plus a card or transfer fee) settles the invoice in full with the excess
  // on 6570. A cross-currency match settles whatever remains: the bank figure
  // is not in the invoice's currency, and storing it with the invoice's
  // currency suffix would render "Betalt 239 USD" on a 25 USD invoice.
  const feeSplit = sameCurrency
    ? splitSupplierBankFee({
        paymentAmount: txAmountAbs,
        remaining,
        bankSek: bankSekRow,
        invoiceRate: invoice.currency === 'SEK' ? 1 : (invoice.exchange_rate ?? null),
        absorbOreRounding: isPureSek,
      })
    : null
  const bankFeeSek = feeSplit?.feeSek ?? 0
  const paymentAmountInvoiceCurrency = feeSplit ? feeSplit.paymentAmount : remaining

  // Ledger math and the overshoot guard. Öre absorption applies to every pure
  // SEK settlement, kontantmetoden included since #2852: a whole-krona payment
  // within 1 kr settles the invoice in full and the residual goes to 3740.
  const ledger = planSupplierPayment(
    { total: invoice.total, paid_amount: invoice.paid_amount, remaining_amount: remaining },
    paymentAmountInvoiceCurrency,
    { absorbOreRounding: isPureSek },
  )
  if (!ledger.ok) return { ok: false, code: ledger.code, details: ledger.details }

  // SEK the invoice was booked at for this payment portion: face value for a
  // SEK invoice, portion x rate for a foreign one with a rate, else unknown.
  // Rounded the way the registration entry rounds it (resolveSekAmountOrNull),
  // so 2440 is cleared at the SEK it was credited with.
  const invoiceFxRate = invoice.exchange_rate ?? null
  const bookedSek =
    invoice.currency === 'SEK'
      ? paymentAmountInvoiceCurrency
      : invoiceFxRate && invoiceFxRate > 0
        ? Math.round(paymentAmountInvoiceCurrency * invoiceFxRate * 100) / 100
        : null

  // SEK that left the bank for the invoice part (net of any fee). A foreign
  // row without amount_sek falls back to the booked SEK (kursdifferens 0).
  // With NEITHER on file there is no SEK figure at all: refuse, the same
  // policy as match_batch_allocate (BATCH_FX_RATE_MISSING) and toSekOrThrow().
  const bankSekStored = feeSplit ? feeSplit.bankSek : bankSekRow
  const actualBankSek = bankSekStored ?? bookedSek
  if (actualBankSek == null) {
    return {
      ok: false,
      code: 'SI_FX_RATE_MISSING',
      details: { transaction_currency: transaction.currency, invoice_currency: invoice.currency },
    }
  }
  const originalBookedSek = bookedSek ?? actualBankSek
  // Positive = kursvinst (2440 carried more SEK than the bank paid), negative
  // = kursförlust.
  const exchangeRateDifference = Math.round((originalBookedSek - actualBankSek) * 100) / 100

  // A cross-currency match is clamped to the remaining balance above, so it
  // always pays it off; a same-currency one does when the ledger plan says so.
  const fullSettlement = !sameCurrency || ledger.plan.isFullyPaid

  // Route on the invoice's booking state, not only the company setting: an
  // invoice posted to 2440 at receipt is cleared off 2440. Only a true
  // kontantmetoden invoice (no registration verifikat) books expense + VAT.
  const invoiceAlreadyBooked = !!invoice.registration_journal_entry_id
  const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

  // Kontantmetoden books the whole invoice at the payment-date rate, so a
  // PARTIAL payment across rates cannot pin the entry.
  if (useCashEntry && exchangeRateDifference !== 0 && !fullSettlement) {
    return {
      ok: false,
      code: 'MATCH_SI_CASH_FX_UNSUPPORTED',
      details: {
        exchangeRateDifference,
        invoiceCurrency: invoice.currency,
        transactionCurrency: transaction.currency,
      },
    }
  }

  // The same holds for a same-currency partial or a part-paid completion: the
  // cash builder books the FULL invoice.
  const cashBlock = cashPartialBlockReason({
    invoiceAlreadyBooked,
    accountingMethod,
    priorPaidAmount: invoice.paid_amount,
    paysRemainingInFull: fullSettlement,
  })
  if (cashBlock) {
    return {
      ok: false,
      code: 'SI_CASH_PARTIAL_UNSUPPORTED',
      details: { reason: cashBlock, payment_amount: txAmountAbs, remaining_amount: remaining },
    }
  }

  let booking: SupplierBankMatchBooking
  if (useCashEntry) {
    // Only a full settlement gets this far (cashPartialBlockReason). A foreign
    // invoice is pinned to the payment-date rate by the SEK that left the bank
    // (no kursdifferens under kontantmetoden); on pure SEK a sub-krona
    // difference to the invoice total goes to 3740. A same-rate foreign
    // settlement keeps the invoice's own rate.
    const settledBankSek = isPureSek || exchangeRateDifference !== 0 ? actualBankSek : undefined
    // Without a settlement SEK the cash builder translates at the invoice's
    // own rate, and a foreign invoice with none makes it throw
    // SI_FX_RATE_MISSING mid-booking, after a door has already reversed a
    // prior categorisation. Refuse here with the same code instead.
    if (settledBankSek === undefined && invoice.currency !== 'SEK' && bookedSek == null) {
      return {
        ok: false,
        code: 'SI_FX_RATE_MISSING',
        details: { transaction_currency: transaction.currency, invoice_currency: invoice.currency },
      }
    }
    booking = { kind: 'cash', settledBankSek, bankFeeSek }
  } else if (isPureSek) {
    // SEK clearing: the bank amount net of the fee against the SEK debt, so a
    // sub-krona difference goes to 3740 and 2440 clears in full; an exact or
    // a krona-or-more short payment clears what moved.
    booking = { kind: 'clearing', paymentAmount: actualBankSek, sekClearingDebt: remaining, bankFeeSek }
  } else {
    // Foreign leg: 2440 cleared at the booked SEK, the bank credited with the
    // SEK that moved, the difference on 3960/7960.
    booking =
      exchangeRateDifference !== 0
        ? { kind: 'clearing', paymentAmount: originalBookedSek, exchangeRateDifference, bankFeeSek }
        : { kind: 'clearing', paymentAmount: actualBankSek, bankFeeSek }
  }

  return {
    ok: true,
    plan: {
      ...ledger.plan,
      settledAmount: roundOre(ledger.plan.newPaidAmount - (invoice.paid_amount || 0)),
      bankFeeSek,
      booking,
    },
  }
}
