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
 *   tx.exchange_rate : populated at ingest only when tx.currency != SEK
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
import { ORE_TOLERANCE, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { resolveSekAmount } from './currency-utils'

const TWO_DP = (n: number): number => Math.round(n * 100) / 100

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
   * invoice settles, and the residual balances the verifikat via 3740.
   */
  oreRoundingSek: number
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
 *     arSek     = |tx.amount| × invoice.exchange_rate (booking rate)
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
 *     arSek    = paidInInvoiceCurrency × invoice.exchange_rate (booking rate)
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
 *   The bank-leg account (the debit line below). Defaults to '1930': callers
 *   that haven't resolved the transaction's actual cash account keep booking
 *   there unchanged. Callers matching a real bank transaction should resolve
 *   it via resolveSettlementAccount (cash_account_id -> cash_accounts.ledger_
 *   account) and pass it here so a receipt into a non-primary bank/cash
 *   account (e.g. a secondary SEK account, or a EUR account on 1940) doesn't
 *   silently get misbooked to the primary account.
 */
export function buildInvoicePaymentClearingLines(
  tx: PaymentClearingTx,
  invoice: PaymentClearingInvoice,
  description: string,
  paidInInvoiceCurrency?: number,
  /**
   * BAS account for the bank leg (the 1930 debit below). Defaults to '1930'
   * to preserve existing behaviour for every caller that doesn't pass one.
   * Callers that know which cash account the underlying bank transaction
   * actually belongs to (via cash_account_id -> cash_accounts.ledger_account,
   * see lib/bookkeeping/settlement-account.ts) should resolve it and pass it
   * here instead of always booking to the primary bank account.
   */
  paymentAccount = '1930',
): PaymentClearingLines {
  // Bank-leg: actual SEK that hit the bank. resolveSekAmount returns the
  // raw amount for SEK txs and amount * exchange_rate for foreign txs
  // (preferring the pre-computed amount_sek when set).
  const bankSek = TWO_DP(
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

  let arSek: number
  let fxDiffSek: number
  let oreRoundingSek = 0

  if (pureSek) {
    // A whole-krona bank settlement of an öre-bearing SEK invoice leaves a
    // sub-krona residual. Clear the FULL remaining off 1510 (invoice → paid)
    // and let 3740 absorb the öre; a ≥1 kr short payment stays a real partial.
    const remainingSek = TWO_DP(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount ?? 0))
    const oreDiff = TWO_DP(remainingSek - bankSek)
    if (oreDiff !== 0 && Math.abs(oreDiff) < ORE_ROUNDING_SETTLEMENT_MAX) {
      arSek = remainingSek
      oreRoundingSek = oreDiff
    } else {
      arSek = bankSek
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
    const invRate = requireInvoiceBookingRate(invoice.exchange_rate, invoice.currency)
    const paidForeign = Math.abs(tx.amount)
    arSek = TWO_DP(paidForeign * invRate)
    fxDiffSek = TWO_DP(arSek - bankSek)
  } else if (paidInInvoiceCurrency != null && paidInInvoiceCurrency > 0) {
    // Proper FX path: caller computed the invoice-currency equivalent
    // using today's spot rate. AR-leg comes off 1510 at the invoice's
    // BOOKING rate (so the GL credit matches what was originally posted
    // for those units of foreign currency). FX diff balances the verifikat.
    const invRate = requireInvoiceBookingRate(invoice.exchange_rate, invoice.currency)
    arSek = TWO_DP(paidInInvoiceCurrency * invRate)
    fxDiffSek = TWO_DP(arSek - bankSek)
  } else {
    // Fallback when no paidInInvoiceCurrency is supplied (e.g. legacy
    // callers, Riksbanken lookup failed with no manual override). Same
    // pre-FX-rewrite behaviour: full-clear gets FX diff, partial defers.
    const invRemainingForeign = invoice.remaining_amount ?? invoice.total - (invoice.paid_amount ?? 0)
    const invRate = requireInvoiceBookingRate(invoice.exchange_rate, invoice.currency)
    const arSekFullRemaining = TWO_DP(invRemainingForeign * invRate)
    if (bankSek >= arSekFullRemaining - 0.005) {
      arSek = arSekFullRemaining
      fxDiffSek = TWO_DP(arSek - bankSek)
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
    if (fxDiffSek > 0) {
      // arSek > bankSek → bank received fewer SEK than booked. Loss → 7960 debit.
      lines.push({
        account_number: '7960',
        debit_amount: Math.abs(fxDiffSek),
        credit_amount: 0,
        line_description: 'Valutakursförlust',
      })
    } else {
      // bankSek > arSek → bank received more SEK than booked. Gain → 3960 credit.
      lines.push({
        account_number: '3960',
        debit_amount: 0,
        credit_amount: Math.abs(fxDiffSek),
        line_description: 'Valutakursvinst',
      })
    }
  }

  // Öresavrundning (3740): pure-SEK only, mutually exclusive with an FX diff.
  // The AR leg above is already the full remaining, so 3740 balances the
  // verifikat: customer paid a sub-krona short → 3740 debit (förlust); over →
  // credit (vinst). Opposite polarity to the supplier side (AP cleared by a Dr).
  if (Math.abs(oreRoundingSek) >= ORE_TOLERANCE) {
    if (oreRoundingSek > 0) {
      lines.push({
        account_number: '3740',
        debit_amount: Math.abs(oreRoundingSek),
        credit_amount: 0,
        line_description: 'Öresavrundning',
      })
    } else {
      lines.push({
        account_number: '3740',
        debit_amount: 0,
        credit_amount: Math.abs(oreRoundingSek),
        line_description: 'Öresavrundning',
      })
    }
  }

  return { bankSek, arSek, fxDiffSek, oreRoundingSek, lines }
}
