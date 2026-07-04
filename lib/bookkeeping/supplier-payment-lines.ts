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
 */
import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'

export interface SupplierClearingArgs {
  /** SEK on 2440 to clear for this settlement: the full remaining when an öre
   *  diff is absorbed, so the invoice reaches `paid`. */
  apSek: number
  /** Actual SEK that left the bank: the payment-account credit. */
  bankSek: number
  /** Bank/clearing account credited (e.g. 1930). */
  paymentAccount: string
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
  const diff = roundOre(apSek - bankSek)

  const isOreRounding = diff !== 0 && Math.abs(diff) < ORE_ROUNDING_SETTLEMENT_MAX

  const lines: CreateJournalEntryLineInput[] = []

  if (isOreRounding) {
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
    if (diff > 0) {
      // Paid fewer kronor than owed → öresavrundningsvinst → 3740 credit.
      lines.push({
        account_number: '3740',
        debit_amount: 0,
        credit_amount: Math.abs(diff),
        line_description: 'Öresavrundning',
      })
    } else {
      // Paid more kronor than owed → öresavrundningsförlust → 3740 debit.
      lines.push({
        account_number: '3740',
        debit_amount: Math.abs(diff),
        credit_amount: 0,
        line_description: 'Öresavrundning',
      })
    }
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
  return { apSek, bankSek, oreDiffSek: 0, lines }
}
