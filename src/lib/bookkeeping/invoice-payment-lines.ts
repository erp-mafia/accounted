/**
 * Builds the journal-entry lines for the clearing entry that closes (fully
 * or partially) a customer invoice against an actual bank transaction.
 *
 * The lines built here are the "Inbetalning kundfaktura" path under
 * faktureringsmetoden (accrual): Dr 1930 / Cr 1510, with a 3960/7960
 * FX-diff line when the invoice and the bank tx are in different currencies.
 *
 * Shared between:
 *   - GET /api/transactions/[id]/match-invoice/preview (read-only, drives
 *     the dialog the user confirms against)
 *   - POST /api/transactions/[id]/match-invoice (the commit path)
 *
 * Single source of truth so the preview and the committed verifikat are
 * byte-identical. Earlier the two diverged on the cross-currency math:
 * the preview ran `resolveSekAmount(tx.amount, null, INV.currency, INV.rate)`,
 * treating the SEK tx number as if it were in the invoice's currency and
 * multiplying by the invoice's stored rate. That produced a fictitious
 * bank-leg amount and silently dropped the FX gain/loss.
 *
 * # Customer-invoice only
 *
 * This helper is the CUSTOMER side (kundfaktura): AR account 1510, FX gain
 * 3960 (valutakursvinster rörelsefordringar), FX loss 7960
 * (valutakursförluster rörelsefordringar), bank-leg = Dr. Supplier-side
 * settlement has the opposite DR/CR polarity (Cr 1930 / Dr 2440-series) and
 * a different account taxonomy; it lives in the match_batch_allocate RPC,
 * not here. Do not call this helper from supplier-invoice flows.
 *
 * # Currency model
 *
 *   tx.currency      : currency of the bank tx (almost always SEK)
 *   tx.amount        : amount in tx.currency
 *   tx.exchange_rate : the Riksbanken SEK rate when tx.currency != SEK; on a
 *                      SEK row it may carry the bank's rate of a purchase made
 *                      in another currency (tx.instructed_currency), which
 *                      resolveSekAmount never reads (SEK short-circuits first)
 *   tx.amount_sek    : pre-computed SEK at ingest for non-SEK tx
 *   invoice.currency : currency the invoice was issued in
 *   invoice.exchange_rate: the rate at which AR was originally booked on 1510.
 *                     REQUIRED whenever the invoice is foreign, regardless of
 *                     the bank tx currency: without it the SEK value of the
 *                     receivable was never established, so the kursvinst /
 *                     kursförlust on settlement is not computable and the
 *                     helper throws InvoiceBookingRateMissingError rather than
 *                     inventing a number. Never needed for a SEK invoice.
 *
 *   Bank-leg (1930) = always the actual SEK that hit the bank.
 *   AR-leg (1510)   = the SEK value of the customer-debt reduction at the
 *                     INVOICE's stored rate (capped to bankSek on partials
 *                     to keep 1510 in sync with invoice.remaining_amount).
 *   FX diff         = (AR-leg SEK − Bank-leg SEK); sign drives 3960 vs 7960.
 *                     Per BFL 5 kap 4-5§ every verifikat must balance to the
 *                     öre; the FX diff line is what makes the cross-currency
 *                     verifikat balance. Only emitted when the bank tx fully
 *                     clears the invoice's remaining: partials defer the
 *                     FX adjustment to the final settlement to avoid
 *                     prematurely zeroing 1510 while the AR row still says
 *                     partially_paid.
 */
import type { CreateJournalEntryLineInput } from '@/types'
import { resolveSekAmount } from './currency-utils'
import { coerceDimensionsBag } from './dimension-resolver'
import { clearedSek } from './ledger-carried-sek'
import { bookedOreRounding, fxDifferenceLine, oreRoundingLine, oreSettlementResidual } from './ore-rounding'
import { overpaymentAllowed, overpaymentExcess, overpaymentLine } from './overpayment'
import { paymentFeeAllowed, paymentFeeLine, paymentFeeShortfall } from './payment-fee'
import { equalOre, roundOre } from '@/lib/money'

/**
 * Structured code for "the foreign-currency invoice carries no usable booking
 * rate". Registered in lib/errors/structured-errors.ts, so errorResponse()
 * turns a throw into the canonical 400 envelope and getErrorMessage() resolves
 * the Swedish sentence. Mirrors the honest BATCH_FX_RATE_MISSING guard in the
 * match_batch_allocate RPC, which refuses the same situation server-side.
 */
export const MATCH_INVOICE_BOOKING_RATE_MISSING = 'MATCH_INVOICE_BOOKING_RATE_MISSING' as const

/**
 * Upper bound mirrors the match_batch_allocate RPC (0 < rate < 100000): a rate
 * that far out is as unusable as NULL and must not silently value the AR leg.
 */
const MAX_PLAUSIBLE_FX_RATE = 100000

/**
 * Raised when a payment settles a foreign-currency invoice whose SEK value was
 * never established. Booking the payment would require a kursvinst/kursförlust
 * on 3960/7960, and that figure is the difference between the SEK actually
 * received and the SEK the receivable was booked at. With no booking rate there
 * is no second number: any "difference" is fabricated. Defaulting the rate to 1
 * (the old `?? 1`) read the foreign amount as if it were SEK and dumped the
 * entire bank receipt minus that number onto 3960 as a phantom kursvinst, with
 * revenue understated by the same amount. The verifikat balanced, so no DB
 * trigger fired: only refusing to post catches it.
 */
export class InvoiceBookingRateMissingError extends Error {
  readonly code = MATCH_INVOICE_BOOKING_RATE_MISSING

  constructor(
    public readonly invoiceCurrency: string,
    public readonly exchangeRate: number | null,
  ) {
    super(
      `Invoice is denominated in ${invoiceCurrency} but carries no usable booking exchange rate ` +
        `(exchange_rate=${exchangeRate === null ? 'null' : String(exchangeRate)}). ` +
        'The FX difference on settlement cannot be computed without the rate the receivable was booked at.',
    )
    this.name = 'InvoiceBookingRateMissingError'
  }
}

/**
 * The invoice's booking rate, or a loud failure. Only ever called when the
 * INVOICE is foreign (settled cross-currency or in its own foreign currency):
 * a SEK invoice never reaches it, because a SEK receivable already carries
 * its own SEK value and needs no rate at all. "Currency is SEK" and "rate is
 * missing" are therefore separate conditions, not one fallback.
 */
function requireInvoiceBookingRate(
  exchangeRate: number | null,
  invoiceCurrency: string,
): number {
  if (
    exchangeRate == null ||
    !Number.isFinite(exchangeRate) ||
    exchangeRate <= 0 ||
    exchangeRate >= MAX_PLAUSIBLE_FX_RATE
  ) {
    throw new InvoiceBookingRateMissingError(invoiceCurrency, exchangeRate)
  }
  return exchangeRate
}

export interface PaymentClearingTx {
  amount: number
  amount_sek: number | null
  currency: string
  exchange_rate: number | null
}

export interface PaymentClearingInvoice {
  currency: string
  exchange_rate: number | null
  remaining_amount: number | null
  total: number
  paid_amount: number | null
  /**
   * What 1510 carries for this invoice (carriedSekOf): a full settlement clears
   * exactly that, a part payment its share. Null or absent: the invoice's
   * booking rate. On a SEK invoice it is set only when the issue verifikat
   * booked the öresavrundning (bookedOreRounding): a full settlement then
   * clears that figure and 3740 takes only the rest of the öre.
   */
  carried_sek?: number | null
}

export interface PaymentClearingLines {
  /** Actual SEK that hit the bank. The 1930 debit. */
  bankSek: number
  /** SEK value of the AR reduction at the invoice's stored rate. The 1510 credit. */
  arSek: number
  /**
   * fxDiffSek = arSek − bankSek (this orientation matches what's needed to
   * make the verifikat balance: positive value goes Dr 7960, negative
   * value goes Cr 3960).
   *
   * Sign reading (note this is the OPPOSITE of an intuitive "profit"
   * orientation: the value here is a balance-adjustment magnitude, not a
   * P&L number, because AR is the side being cleared):
   *   positive → bank received FEWER SEK than AR was booked at → kursförlust → 7960 Dr
   *   negative → bank received MORE  SEK than AR was booked at → kursvinst   → 3960 Cr
   *   |value| ≤ 0.005 → no FX diff line emitted (floating-point tolerance,
   *                     NOT a rounding allowance per BFL 5 kap 4-5§)
   *
   * If you want an intuitive "gain" number for UI display, use
   * `bankSek - arSek` (negate this field). Do not consume the raw sign
   * in caller logic without reading this paragraph.
   */
  fxDiffSek: number
  /**
   * Öresavrundning residual (SEK), pure-SEK same-currency settlements only.
   * remainingSek − bankSek: >0 → customer paid a sub-krona short (3740 debit,
   * förlust); <0 → paid a sub-krona over (3740 credit, vinst); 0 → no 3740 line.
   * When non-zero the AR leg (1510) is credited the FULL remaining so the
   * invoice settles, and the residual balances the verifikat via 3740. When
   * the issue verifikat already booked öre (bookedOreRounding), the AR leg is
   * what 1510 carries and this is the residual less those öre.
   */
  oreRoundingSek: number
  /**
   * Customer overpayment (SEK) booked on the caller's overpayment account:
   * bankSek − remainingSek when that is a krona or more and the caller named
   * an account allowed to take it (overpayment.ts), else 0. When non-zero the
   * AR leg is the FULL remaining and the excess is credited to that account.
   */
  overpaymentSek: number
  /**
   * A payment provider's fee (SEK) booked on the caller's fee account:
   * remainingSek − bankSek when that is a krona or more, under the fee cap,
   * and the caller named an account allowed to take it (payment-fee.ts), else
   * 0. When non-zero the AR leg is the FULL remaining and the fee is debited
   * to that account (crm#1364).
   */
  feeSek: number
  lines: CreateJournalEntryLineInput[]
}

/**
 * Build the verifikat lines for a customer-invoice payment matched against
 * a bank tx. Pure: no DB calls. Caller decides how to persist.
 *
 * # Same-currency, both SEK (or SEK invoice paid from a foreign account)
 *   Bank-leg = AR-leg = bankSek. No FX diff line: a SEK receivable has no FX
 *   exposure, so the invoice's exchange_rate is never consulted.
 *
 * # Same-currency, foreign (EUR invoice settled by a EUR bank tx)
 *   The foreign units paid are known exactly (|tx.amount|), so:
 *     arSek     = the SEK 1510 carries for those units (clearedSek)
 *     fxDiffSek = arSek − bankSek
 *   1510 is cleared at the SEK value the receivable was booked at and the
 *   difference against the actual SEK bank leg is the REALIZED kursvinst /
 *   kursförlust (3960/7960), exactly like the cross-currency path. Booking
 *   arSek = bankSek here (the pre-fix behaviour) over/under-credited 1510 by
 *   the whole rate movement and stranded the realized kursdiff on the balance
 *   sheet instead of the P&L.
 *
 * # Cross-currency with explicit paidInInvoiceCurrency (preferred path)
 *   The caller supplies how many units of the invoice's currency this bank
 *   payment satisfies (typically computed as `bankSek / today_rate` where
 *   `today_rate` is the Riksbanken spot rate on the payment date: see
 *   `app/api/transactions/[id]/match-invoice/route.ts`). The helper then:
 *     arSek    = the SEK 1510 carries for those units (clearedSek)
 *     fxDiffSek = arSek − bankSek
 *   For a partial cross-currency payment this credits 1510 by the
 *   proportional foreign amount (not the full remaining) and posts the
 *   accurate FX-diff line. The verifikat balances per BFL 5 kap 4-5§ and
 *   the GL stays in sync with the AR sub-ledger because both move in step.
 *
 * # Cross-currency without paidInInvoiceCurrency (fallback)
 *   Earlier behaviour, kept for callers that haven't been updated yet:
 *   if `bankSek >= remaining × rate`, book the full FX diff (full clear);
 *   otherwise defer (book 1930 = 1510 = bankSek with no FX line). The
 *   deferred path leaves the GL slightly understated until the final
 *   settlement closes the invoice.
 *
 * # Foreign invoice with no booking rate
 *   Throws InvoiceBookingRateMissingError (code
 *   MATCH_INVOICE_BOOKING_RATE_MISSING). Every foreign-invoice path above
 *   (same-currency foreign and both cross-currency paths) values the AR leg
 *   at the invoice's booking rate; without it the SEK value of the receivable
 *   is unknown and the kursvinst/kursförlust is not a computable number. The
 *   caller must obtain the rate the invoice was booked at instead of posting
 *   a guess. Only a SEK invoice can never throw: it is settled entirely by
 *   the SEK branches and never consults invoice.exchange_rate.
 *
 * # paymentAccount
 *   The bank-leg account (the debit line below): the cash account the
 *   transaction belongs to, from resolveSettlementAccount (cash_account_id ->
 *   cash_accounts.ledger_account), so a receipt into a non-primary bank or
 *   cash account (a secondary SEK account, a EUR account on 1940) books there.
 *
 * # overpaymentAccount
 *   Pure SEK only. When the bank moved a krona or more above the remaining
 *   and this names an account allowed to take the excess (2420, or 3740
 *   under its cap: see overpayment.ts), 1510 is credited the full remaining
 *   and the excess goes to that account. Without it the caller must have
 *   refused the overshoot (planInvoicePayment does) before building.
 *
 * # feeAccount
 *   Pure SEK only, the mirror: when the bank moved a krona or more BELOW the
 *   remaining (a payment provider's payout net of its fee) and this names an
 *   account allowed to take the shortfall (6570 under its cap: see
 *   payment-fee.ts), 1510 is credited the full remaining and the fee is
 *   debited to that account. Without it the shortfall stays a partial.
 */
export function buildInvoicePaymentClearingLines(
  tx: PaymentClearingTx,
  invoice: PaymentClearingInvoice,
  description: string,
  paidInInvoiceCurrency: number | undefined,
  /**
   * BAS account for the bank leg (the debit below): the cash account the bank
   * transaction belongs to (lib/bookkeeping/settlement-account.ts).
   */
  paymentAccount: string,
  overpaymentAccount?: string,
  feeAccount?: string,
): PaymentClearingLines {
  // Bank-leg: actual SEK that hit the bank. resolveSekAmount returns the
  // raw amount for SEK txs and amount * exchange_rate for foreign txs
  // (preferring the pre-computed amount_sek when set).
  const bankSek = roundOre(
    resolveSekAmount(
      Math.abs(tx.amount),
      tx.amount_sek != null ? Math.abs(tx.amount_sek) : null,
      tx.currency,
      tx.exchange_rate,
    ),
  )

  const sameCurrency = tx.currency === invoice.currency
  const invoiceIsForeign = invoice.currency !== 'SEK'
  // Pure SEK both sides: the only place whole-krona öresavrundning applies.
  const pureSek = sameCurrency && invoice.currency === 'SEK'
  const remainingInInvoiceCurrency = invoice.remaining_amount ?? invoice.total - (invoice.paid_amount ?? 0)
  // What 1510 gives up for `amount` of the invoice's currency.
  const arSekOf = (amount: number): number =>
    clearedSek({
      amount,
      remaining: remainingInInvoiceCurrency,
      carried: invoice.carried_sek ?? null,
      rate: requireInvoiceBookingRate(invoice.exchange_rate, invoice.currency),
    })

  let arSek: number
  let fxDiffSek: number
  let oreRoundingSek = 0
  let overpaymentSek = 0
  let feeSek = 0

  if (pureSek) {
    // A whole-krona bank settlement of an öre-bearing SEK invoice leaves a
    // sub-krona residual. Clear the FULL remaining off 1510 (invoice → paid)
    // and let 3740 absorb the öre; a ≥1 kr short payment stays a real partial.
    const remainingSek = roundOre(remainingInInvoiceCurrency)
    const oreDiff = oreSettlementResidual(remainingSek, bankSek)
    const excess = overpaymentExcess(remainingSek, bankSek)
    const shortfall = paymentFeeShortfall(remainingSek, bankSek)
    if (oreDiff !== 0) {
      arSek = remainingSek
      oreRoundingSek = oreDiff
    } else if (excess !== 0 && overpaymentAccount && overpaymentAllowed(overpaymentAccount, excess)) {
      arSek = remainingSek
      overpaymentSek = excess
    } else if (shortfall !== 0 && feeAccount && paymentFeeAllowed(feeAccount, shortfall, remainingSek)) {
      arSek = remainingSek
      feeSek = shortfall
    } else {
      arSek = bankSek
    }
    // The issue verifikat may have booked the öresavrundning already (1510 at
    // the rounded "Att betala", the öre on 3740). A settlement in full then
    // clears what 1510 carries and 3740 takes only the rest, so the öre are
    // not booked twice and 1510 ends at zero. A part payment clears its own
    // kronor; the gap waits for the settlement.
    const issueOre = bookedOreRounding(remainingSek, invoice.carried_sek)
    if (issueOre !== 0 && equalOre(arSek, remainingSek)) {
      arSek = roundOre(remainingSek - issueOre)
      oreRoundingSek = roundOre(oreRoundingSek - issueOre)
    }
    fxDiffSek = 0
  } else if (!invoiceIsForeign) {
    // SEK invoice settled from a non-SEK bank account: the receivable is a
    // kronor claim, so the customer-debt reduction equals the SEK that hit
    // the bank. The invoice's exchange_rate is never consulted.
    arSek = bankSek
    fxDiffSek = 0
  } else if (sameCurrency) {
    // Foreign invoice settled in its own currency (EUR invoice, EUR tx). The
    // foreign units paid are known exactly, so clear 1510 at the invoice's
    // BOOKING rate for those units and book the difference against the actual
    // SEK bank leg as the realized kursdiff, exactly like the cross-currency
    // path below. Setting arSek = bankSek here (the old behaviour) credited
    // 1510 at the settlement-date value: a 1 000 EUR invoice booked at 11,30
    // (11 300,00 on 1510) settled by a tx worth 11 496,70 kr over-credited
    // 1510 by 196,70 and the realized kursvinst never reached 3960.
    arSek = arSekOf(Math.abs(tx.amount))
    fxDiffSek = roundOre(arSek - bankSek)
  } else if (paidInInvoiceCurrency != null && paidInInvoiceCurrency > 0) {
    // Proper FX path: caller computed the invoice-currency equivalent
    // using today's spot rate. AR-leg comes off 1510 at the invoice's
    // BOOKING rate (so the GL credit matches what was originally posted
    // for those units of foreign currency). FX diff balances the verifikat.
    arSek = arSekOf(paidInInvoiceCurrency)
    fxDiffSek = roundOre(arSek - bankSek)
  } else {
    // Fallback when no paidInInvoiceCurrency is supplied (e.g. legacy
    // callers, Riksbanken lookup failed with no manual override). Same
    // pre-FX-rewrite behaviour: full-clear gets FX diff, partial defers.
    const arSekFullRemaining = arSekOf(remainingInInvoiceCurrency)
    if (bankSek >= arSekFullRemaining - 0.005) {
      arSek = arSekFullRemaining
      fxDiffSek = roundOre(arSek - bankSek)
    } else {
      arSek = bankSek
      fxDiffSek = 0
    }
  }

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: paymentAccount,
      debit_amount: bankSek,
      credit_amount: 0,
      line_description: description,
    },
    {
      account_number: '1510',
      debit_amount: 0,
      credit_amount: arSek,
      line_description: description,
    },
  ]

  // Tolerance of 0.005 SEK is for floating-point equalisation only, not a
  // rounding allowance per BFL 5 kap 4-5§. Same rationale as the balance
  // pre-check in gnubok_bulk_book_transactions.
  if (Math.abs(fxDiffSek) > 0.005) {
    // arSek > bankSek: the bank received fewer SEK than booked, a loss (Dr
    // 7960); bankSek > arSek a gain (Cr 3960).
    lines.push(fxDifferenceLine(-fxDiffSek))
  }

  // Öresavrundning (3740): pure-SEK only, mutually exclusive with an FX diff.
  // The AR leg above is already the full remaining (or what 1510 carries), so
  // 3740 balances the verifikat: customer paid short → 3740 debit (förlust);
  // over → credit (vinst). Opposite polarity to the supplier side (AP cleared
  // by a Dr).
  if (oreRoundingSek !== 0) {
    lines.push(oreRoundingLine(oreRoundingSek, 'customer'))
  }
  if (overpaymentSek !== 0) {
    lines.push(overpaymentLine(overpaymentSek, overpaymentAccount!))
  }
  if (feeSek !== 0) {
    lines.push(paymentFeeLine(feeSek, feeAccount!))
  }

  return { bankSek, arSek, fxDiffSek, oreRoundingSek, overpaymentSek, feeSek, lines }
}

/**
 * The verifikat text of a bank-matched customer payment: the entry header and
 * the bank and 1510 rows of its clearing lines. One definition for the match
 * routes, the agent executor and the match preview.
 */
export function invoiceMatchPaymentDescription(invoice: {
  invoice_number: string | null
  customer?: { name?: string | null } | null
}): string {
  return invoice.customer?.name
    ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
    : `Inbetalning kundfaktura ${invoice.invoice_number}`
}

export interface InvoiceMatchClearingInvoice extends PaymentClearingInvoice {
  invoice_number: string | null
  customer?: { name?: string | null } | null
  /** The invoice's stored bag; every clearing leg carries it. */
  default_dimensions?: unknown
}

/**
 * The clearing verifikat of a bank-matched customer payment, exactly as the
 * match routes and the agent executor book it and the match preview shows
 * it: buildInvoicePaymentClearingLines under the payment's description, with
 * the invoice's dimension bag on every leg (FX and öre lines included, so a
 * project's kursvinst stays inside the project's result).
 */
export function buildInvoiceMatchClearingLines(
  tx: PaymentClearingTx,
  invoice: InvoiceMatchClearingInvoice,
  paidInInvoiceCurrency: number | undefined,
  paymentAccount: string,
  overpaymentAccount?: string,
  feeAccount?: string,
): { description: string; lines: CreateJournalEntryLineInput[] } {
  const description = invoiceMatchPaymentDescription(invoice)
  const { lines } = buildInvoicePaymentClearingLines(
    tx,
    invoice,
    description,
    paidInInvoiceCurrency,
    paymentAccount,
    overpaymentAccount,
    feeAccount,
  )
  const bag = coerceDimensionsBag(invoice.default_dimensions)
  if (bag) {
    // Copied per line: a shared object would let one line's mutation leak.
    for (const line of lines) line.dimensions = { ...bag }
  }
  return { description, lines }
}
