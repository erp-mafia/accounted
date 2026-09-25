/**
 * Builds the journal-entry lines for the clearing entry that closes (fully or
 * partially) a supplier invoice against an actual bank transaction under
 * faktureringsmetoden (accrual): Dr 2440 / Cr <payment account>.
 *
 * Shared between:
 *   - GET /api/transactions/[id]/match-supplier-invoice/preview (read-only,
 *     drives the dialog the user confirms against)
 *   - POST /api/transactions/[id]/match-supplier-invoice (the commit path)
 *
 * Single source of truth so the preview and the committed verifikat are
 * byte-identical: including the payment account and the per-line descriptions,
 * which previously drifted (the preview used `last_supplier_payment_account` and
 * "Kvittning leverantörsskuld" / "Utbetalning från bank", while the commit path
 * defaulted to 1930 and "Utbetalning leverantörsfaktura …").
 *
 * # Öresavrundning (3740)
 *
 * A whole-krona Bankgiro/Swish settlement of an öre-bearing invoice total leaves
 * a sub-krona residual (e.g. paying 11 231,25 with a rounded 11 231,00). Rather
 * than strand that 0,25 kr as a permanent partial, the difference is booked to
 * BAS 3740 (Öres- och kronutjämning) and 2440 is cleared in full so the invoice
 * reaches `paid`. The residual sign drives the 3740 side:
 *
 *   bank paid LESS than owed (apSek > bankSek)  → öresavrundningsvinst → Cr 3740
 *   bank paid MORE than owed (apSek < bankSek)  → öresavrundningsförlust → Dr 3740
 *
 * This polarity is the mirror of the customer side (`buildInvoicePaymentClearingLines`,
 * where AR is cleared with a credit and 3740 takes the opposite side).
 *
 * # SEK only
 *
 * `apSek`/`bankSek` are home-currency (SEK). Cross-currency settlement carries a
 * kursvinst/kursförlust (3960/7960) handled by `createSupplierInvoicePaymentEntry`,
 * not here: öresavrundning is the residual AFTER FX and only meaningful in whole
 * SEK kronor, so callers route only same-currency SEK payments through this helper.
 *
 * # One residual rule for both methods
 *
 * `supplierOreResidual` + `supplierOreRoundingLine` are the only place the
 * supplier side decides "is this an öresavrundning, and which side of 3740".
 * The accrual clearing builder below and the kontantmetoden builder
 * (`buildSupplierInvoiceCashLines`, via `resolveSupplierCashSettlement`) both
 * go through them, so the two methods cannot drift apart again (#2852: the
 * cash path credited the exact öre while the user paid whole kronor).
 */
import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre, ORE_ROUNDING_ACCOUNT, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { RESIDUAL_KINDS } from '@/lib/reconciliation/residual'
import {
  supplierInvoiceDisplayFigures,
  type SupplierInvoiceDisplayInput,
} from '@/lib/supplier-invoices/display-figures'

export interface SupplierClearingArgs {
  /** SEK on 2440 to clear for this settlement: the full remaining when an öre
   *  diff is absorbed, so the invoice reaches `paid`. */
  apSek: number
  /** Actual SEK that left the bank: the payment-account credit. */
  bankSek: number
  /** Bank/clearing account credited (e.g. 1930). */
  paymentAccount: string
  /** Bank fee on top of the invoice (splitSupplierBankFee), booked on 6570. */
  bankFeeSek?: number
}

export interface SupplierClearingResult {
  apSek: number
  bankSek: number
  /** roundOre(apSek − bankSek): >0 → 3740 credit (vinst); <0 → 3740 debit
   *  (förlust); 0 → no 3740 line. Non-zero only within ORE_ROUNDING_SETTLEMENT_MAX. */
  oreDiffSek: number
  lines: CreateJournalEntryLineInput[]
}

/**
 * The öresavrundning residual of a SEK supplier settlement:
 * roundOre(owedSek - bankSek) when it is non-zero and strictly inside
 * ORE_ROUNDING_SETTLEMENT_MAX, else 0 (an exact settlement, or a genuine
 * difference of a krona or more, which is never rounding).
 *
 *   > 0: the bank paid LESS than owed  -> öresavrundningsvinst  -> Cr 3740
 *   < 0: the bank paid MORE than owed  -> öresavrundningsförlust -> Dr 3740
 */
export function supplierOreResidual(owedSek: number, bankSek: number): number {
  const diff = roundOre(roundOre(owedSek) - roundOre(bankSek))
  return diff !== 0 && Math.abs(diff) < ORE_ROUNDING_SETTLEMENT_MAX ? diff : 0
}

/** The 3740 line for a non-zero `supplierOreResidual`. 3740 carries no VAT. */
export function supplierOreRoundingLine(residual: number): CreateJournalEntryLineInput {
  return {
    account_number: ORE_ROUNDING_ACCOUNT,
    debit_amount: residual < 0 ? Math.abs(residual) : 0,
    credit_amount: residual > 0 ? residual : 0,
    line_description: 'Öresavrundning',
  }
}

/**
 * Book a bank fee that left the bank together with a supplier payment
 * (splitSupplierBankFee): Dr 6570 Bankavgift, and the payment-account credit
 * grows by the same amount so it equals the whole bank row. Mutates `lines`.
 * Shared by every supplier-match builder and the preview, so the fee is
 * booked the same way on each path.
 */
export function addSupplierBankFeeLine(
  lines: CreateJournalEntryLineInput[],
  paymentAccount: string,
  feeSek: number | undefined,
): void {
  const fee = roundOre(feeSek ?? 0)
  if (fee <= 0) return
  const bankLine = lines.find((l) => l.account_number === paymentAccount && l.credit_amount > 0)
  if (bankLine) {
    bankLine.credit_amount = roundOre(bankLine.credit_amount + fee)
  } else {
    lines.push({
      account_number: paymentAccount,
      debit_amount: 0,
      credit_amount: fee,
      line_description: 'Utbetalning från bank',
    })
  }
  lines.push({
    account_number: RESIDUAL_KINDS.bank_fee.account,
    debit_amount: fee,
    credit_amount: 0,
    line_description: RESIDUAL_KINDS.bank_fee.label_sv,
  })
}

export interface SupplierCashSettlementArgs {
  /** The invoice's rounding inputs (total, currency, per-invoice flag). */
  invoice: SupplierInvoiceDisplayInput
  /** SEK the cash entry's expense + VAT legs net to: the debt being settled. */
  owedSek: number
  /**
   * SEK that actually left the bank, when the payment is matched from a bank
   * row. Omit on the mark-paid doors, where no bank row is known.
   */
  knownBankSek?: number
}

export interface SupplierCashSettlement {
  /** The payment-account credit. */
  bankSek: number
  /** `supplierOreResidual(owedSek, bankSek)`; non-zero means a 3740 line. */
  oreDiffSek: number
}

/**
 * What a kontantmetoden supplier payment credits the payment account with,
 * and the öre residual 3740 carries. SEK invoices only (a foreign invoice is
 * pinned to the payment-date rate by the builder instead).
 *
 *   bank row known   -> the bank row IS the payment. A sub-krona difference to
 *                       the debt is öresavrundning, exactly as on the accrual
 *                       clearing path; the per-invoice flag is irrelevant. An
 *                       exact row, or one a krona or more off, books the exact
 *                       debt as before (the routes' overshoot and partial
 *                       guards own that case).
 *   no bank row      -> the user was told to pay `toPay`
 *                       (supplierInvoiceDisplayFigures): whole kronor when the
 *                       invoice carries display-only öresavrundning, else the
 *                       exact total. The supplier-side mirror of the customer
 *                       proposal's `roundingDelta` (proposeCashLines).
 */
export function resolveSupplierCashSettlement(
  args: SupplierCashSettlementArgs,
): SupplierCashSettlement {
  const owedSek = roundOre(args.owedSek)
  if (args.invoice.currency !== 'SEK' || owedSek <= 0) {
    return { bankSek: owedSek, oreDiffSek: 0 }
  }
  const target =
    args.knownBankSek != null && args.knownBankSek > 0
      ? args.knownBankSek
      : supplierInvoiceDisplayFigures(args.invoice).toPay
  const oreDiffSek = supplierOreResidual(owedSek, target)
  return { bankSek: roundOre(owedSek - oreDiffSek), oreDiffSek }
}

/**
 * Build the verifikat lines for a supplier-invoice payment matched against a
 * SEK bank tx. Pure: no DB calls. Caller decides how to persist.
 *
 *   |apSek − bankSek| < ORE_ROUNDING_SETTLEMENT_MAX (and ≠ 0)
 *       → clear the full apSek off 2440, credit the actual bankSek, book the
 *         residual to 3740. Invoice settles fully.
 *   otherwise (exact, or a genuine ≥ 1 kr partial)
 *       → clear min(bankSek, apSek), no 3740 line (unchanged legacy behaviour).
 */
export function buildSupplierPaymentClearingLines(
  args: SupplierClearingArgs,
): SupplierClearingResult {
  const apSek = roundOre(args.apSek)
  const bankSek = roundOre(args.bankSek)
  const diff = supplierOreResidual(apSek, bankSek)

  const lines: CreateJournalEntryLineInput[] = []

  if (diff !== 0) {
    // Clear the FULL debt off 2440 so the invoice → paid; the bank leg is the
    // actual SEK paid; 3740 absorbs the öre residual.
    lines.push({
      account_number: '2440',
      debit_amount: apSek,
      credit_amount: 0,
      line_description: 'Kvittning leverantörsskuld',
    })
    lines.push({
      account_number: args.paymentAccount,
      debit_amount: 0,
      credit_amount: bankSek,
      line_description: 'Utbetalning från bank',
    })
    // Paid fewer kronor than owed → vinst → 3740 credit; more → förlust → debit.
    lines.push(supplierOreRoundingLine(diff))
    addSupplierBankFeeLine(lines, args.paymentAccount, args.bankFeeSek)
    return { apSek, bankSek, oreDiffSek: diff, lines }
  }

  // Exact settlement, or a genuine partial payment (≥ 1 kr short): clear what
  // was actually moved, leave any remainder on the supplier ledger.
  const amount = roundOre(Math.min(bankSek, apSek))
  lines.push({
    account_number: '2440',
    debit_amount: amount,
    credit_amount: 0,
    line_description: 'Kvittning leverantörsskuld',
  })
  lines.push({
    account_number: args.paymentAccount,
    debit_amount: 0,
    credit_amount: amount,
    line_description: 'Utbetalning från bank',
  })
  addSupplierBankFeeLine(lines, args.paymentAccount, args.bankFeeSek)
  return { apSek, bankSek, oreDiffSek: 0, lines }
}
