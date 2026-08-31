/**
 * Pure function to compute proposed journal entry lines for an invoice payment.
 * Used by the PaymentBookingDialog to pre-fill the editable line grid.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { resolveSekAmount, resolveSekAmountOrNull } from './currency-utils'
import { roundOre, ORE_TOLERANCE, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import {
  getRevenueAccount,
  getOutputVatAccount,
  InvoiceFxRateMissingError,
} from './invoice-accounts'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { EntityType, InvoiceItem, VatTreatment } from '@/types'

export interface ProposePaymentLinesInput {
  invoice: {
    invoice_number: string | null
    total: number
    total_sek?: number | null
    subtotal: number
    subtotal_sek?: number | null
    vat_amount: number
    vat_amount_sek?: number | null
    currency: string
    exchange_rate?: number | null
    vat_treatment: VatTreatment
    items?: InvoiceItem[]
    /** Per-invoice öresavrundning override; null = inherit the company setting. */
    ore_rounding?: boolean | null
    /**
     * ROT/RUT-avdrag (fakturamodellen), invoice currency. The customer pays
     * total minus this; the rest is a receivable on Skatteverket (1513) that
     * was debited at issue (accrual) or is debited at payment (cash method).
     * The proposal must therefore never expect the deduction on the bank leg:
     * doing so is what made every ROT/RUT invoice fail the overpayment guard.
     */
    deduction_total?: number | null
    /**
     * Dimensions PR7: the invoice's default bag. Stamped on every proposed
     * line: the payment dialog always submits its (editable) lines, so the
     * preview IS the booked entry and must re-propagate the tag like the
     * no-override generator path does. Per-item bags are not split out here
     * (the preview groups per rate); users can retag lines in the grid.
     */
    default_dimensions?: Record<string, string> | null
    /**
     * Prior-payment state (#1717). When a partial payment exists the proposal
     * must clear what actually remains, not the full total: a full-total
     * proposal is rejected server-side with MATCH_AMOUNT_EXCEEDS_REMAINING,
     * which left invoices stuck in partially_paid with an öre remaining.
     * Absent or fully-unpaid values keep the proposal identical to before.
     */
    paid_amount?: number | null
    remaining_amount?: number | null
  }
  accountingMethod: 'accrual' | 'cash'
  entityType: EntityType
  paymentAccount?: string
  exchangeRateDifference?: number
  /**
   * company_settings.ore_rounding. Combined with the per-invoice override via
   * getDisplayTotal (SEK only, default-on) to decide whether the proposal
   * expects the customer to pay the rounded "Att betala" from the PDF: then
   * the bank leg is the rounded amount and 3740 carries the residual.
   */
  companyOreRounding?: boolean
}

function toFormAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return rounded === 0 ? '' : rounded.toString()
}

/**
 * Resolve the journal_entries.source_type used when booking an invoice payment.
 *
 * Mirrors the branching in app/api/invoices/[id]/mark-paid/route.ts: revenue is
 * only recognised at payment (kontantmetoden / invoice_cash_payment) when the
 * invoice has no prior issuance verifikat AND the company is on the cash method.
 * Otherwise the payment clears the receivable (invoice_paid).
 *
 * Shared so the dialog's voucher preview and the route's actual booking always
 * resolve the same series: they must not drift.
 */
export function resolveInvoicePaymentSourceType(opts: {
  invoiceAlreadyBooked: boolean
  accountingMethod: 'accrual' | 'cash'
}): 'invoice_cash_payment' | 'invoice_paid' {
  const useCashEntry = !opts.invoiceAlreadyBooked && opts.accountingMethod === 'cash'
  return useCashEntry ? 'invoice_cash_payment' : 'invoice_paid'
}

/**
 * Propose journal entry lines for an invoice payment.
 *
 * Accrual: Debit paymentAccount, Credit 1510, optional exchange rate diff.
 * Cash: Debit paymentAccount, Credit 30xx + 26xx per VAT rate group.
 */
export function proposePaymentLines(input: ProposePaymentLinesInput): FormLine[] {
  const { invoice, accountingMethod, entityType, exchangeRateDifference } = input
  const paymentAccount = input.paymentAccount || '1930'
  const desc = invoice.invoice_number ? `Betalning faktura ${invoice.invoice_number}` : 'Betalning faktura'

  // #1717: an invoice with a prior partial payment gets a proposal that
  // clears the actual remaining, never the full total.
  const remainingAware = proposeRemainingAwareLines(invoice, accountingMethod, paymentAccount, desc)
  if (remainingAware) return withInvoiceDimensions(remainingAware, invoice)

  // Öresavrundning: when it applies (SEK, enabled, non-integer total) the
  // customer pays the rounded "Att betala" from the PDF, not the stored öre
  // total. Propose the bank leg at the rounded amount and let 3740 carry the
  // residual, so the default booking matches what actually hits the bank.
  // getDisplayTotal returns delta 0 whenever rounding does not apply.
  const roundingDelta = getDisplayTotal(
    { total: invoice.total, currency: invoice.currency, ore_rounding: invoice.ore_rounding },
    input.companyOreRounding === undefined ? undefined : { ore_rounding: input.companyOreRounding },
  ).roundingDelta

  // 1513 is a kronor receivable, so the deduction converts with the invoice's
  // booking rate or not at all: same refusal as generateRotRutLines.
  const deductionSek = resolveDeductionSek(invoice)

  const lines = accountingMethod === 'accrual'
    ? proposeAccrualLines(invoice, paymentAccount, desc, exchangeRateDifference, roundingDelta, deductionSek)
    : proposeCashLines(invoice, paymentAccount, desc, entityType, roundingDelta, deductionSek)

  return withInvoiceDimensions(lines, invoice)
}

/**
 * Remaining-aware proposal for an invoice with a prior partial payment
 * (#1717). Returns null whenever the legacy full-total proposal applies, so
 * fresh unpaid invoices keep a byte-identical proposal.
 *
 * Scope: SEK + accrual + no ROT/RUT deduction only.
 *   - Cash-method partial completion is refused server-side
 *     (cashPartialBlockReason: the generated cash entry always books the full
 *     invoice), so a remaining-based cash proposal would only book a rejected
 *     entry with a nicer preview.
 *   - A foreign-currency remaining needs a payment-day FX conversion this
 *     pure function does not carry; the dialog's FX path already handles it.
 *   - On a ROT/RUT invoice the outstanding remainder is (or includes)
 *     Skatteverket's share, which sits on 1513 and is settled by the ROT/RUT
 *     payout flow, not by clearing 1510 here.
 *
 * Two shapes:
 *   - 0 < remaining < 1 kr (the stuck öresavrundning case): a bank-less
 *     write-off, Dr 3740 / Cr 1510, so one click closes the invoice. Polarity
 *     per buildInvoicePaymentClearingLines: the customer under-paid, so 3740
 *     takes the debit (öresavrundningsförlust).
 *   - remaining >= 1 kr: a normal clearing of the remaining, Dr bank /
 *     Cr 1510.
 */
function proposeRemainingAwareLines(
  invoice: ProposePaymentLinesInput['invoice'],
  accountingMethod: 'accrual' | 'cash',
  paymentAccount: string,
  desc: string,
): FormLine[] | null {
  if (accountingMethod !== 'accrual') return null
  if (invoice.currency !== 'SEK') return null
  if ((invoice.deduction_total ?? 0) > 0) return null

  const total = roundOre(invoice.total)
  const remaining = roundOre(
    invoice.remaining_amount ?? invoice.total - (invoice.paid_amount ?? 0),
  )
  const hasPartial = remaining > ORE_TOLERANCE && total - remaining > ORE_TOLERANCE
  if (!hasPartial) return null

  if (remaining < ORE_ROUNDING_SETTLEMENT_MAX) {
    return [
      {
        account_number: '3740',
        debit_amount: toFormAmount(remaining),
        credit_amount: '',
        line_description: 'Öresavrundning',
      },
      {
        account_number: '1510',
        debit_amount: '',
        credit_amount: toFormAmount(remaining),
        line_description: desc,
      },
    ]
  }

  return [
    {
      account_number: paymentAccount,
      debit_amount: toFormAmount(remaining),
      credit_amount: '',
      line_description: desc,
    },
    {
      account_number: '1510',
      debit_amount: '',
      credit_amount: toFormAmount(remaining),
      line_description: desc,
    },
  ]
}

/**
 * Dimensions PR7: re-propagate the invoice default onto every proposed leg
 * (matches createInvoicePaymentJournalEntry/createInvoiceCashEntry).
 */
function withInvoiceDimensions(
  lines: FormLine[],
  invoice: ProposePaymentLinesInput['invoice'],
): FormLine[] {
  const bag = invoice.default_dimensions
  if (bag && Object.keys(bag).length > 0) {
    return lines.map((line) => ({ ...line, dimensions: { ...bag } }))
  }
  return lines
}

function resolveDeductionSek(invoice: ProposePaymentLinesInput['invoice']): number {
  const deduction = invoice.deduction_total ?? 0
  if (deduction <= 0) return 0
  const sek = resolveSekAmountOrNull(deduction, null, invoice.currency, invoice.exchange_rate)
  if (sek === null) throw new InvoiceFxRateMissingError(invoice.currency)
  return roundOre(sek)
}

/**
 * The 3740 (öres- och kronutjämning) residual line. Customer paid over the
 * stored total (rounded up) → credit (vinst); under (rounded down) → debit
 * (förlust). Same polarity as buildInvoicePaymentClearingLines.
 */
function oreRoundingLine(roundingDelta: number): FormLine {
  return {
    account_number: '3740',
    debit_amount: roundingDelta < 0 ? toFormAmount(Math.abs(roundingDelta)) : '',
    credit_amount: roundingDelta > 0 ? toFormAmount(roundingDelta) : '',
    line_description: 'Öresavrundning',
  }
}

function proposeAccrualLines(
  invoice: ProposePaymentLinesInput['invoice'],
  paymentAccount: string,
  desc: string,
  exchangeRateDifference?: number,
  roundingDelta = 0,
  deductionSek = 0
): FormLine[] {
  // The customer's share only: 1510 was debited total minus the ROT/RUT
  // deduction at issue (1513 took the rest), so that is what the payment clears.
  const bookedSekAmount = Math.round((resolveSekAmount(
    invoice.total,
    invoice.total_sek,
    invoice.currency,
    invoice.exchange_rate
  ) - deductionSek) * 100) / 100
  const lines: FormLine[] = []

  if (exchangeRateDifference && exchangeRateDifference !== 0) {
    const actualSekReceived = bookedSekAmount + exchangeRateDifference

    lines.push({
      account_number: paymentAccount,
      debit_amount: toFormAmount(actualSekReceived),
      credit_amount: '',
      line_description: desc,
    })

    lines.push({
      account_number: '1510',
      debit_amount: '',
      credit_amount: toFormAmount(bookedSekAmount),
      line_description: desc,
    })

    if (exchangeRateDifference > 0) {
      lines.push({
        account_number: '3960',
        debit_amount: '',
        credit_amount: toFormAmount(exchangeRateDifference),
        line_description: 'Valutakursvinst',
      })
    } else {
      lines.push({
        account_number: '7960',
        debit_amount: toFormAmount(Math.abs(exchangeRateDifference)),
        credit_amount: '',
        line_description: 'Valutakursförlust',
      })
    }
  } else {
    const amount = Math.round(bookedSekAmount * 100) / 100
    lines.push({
      account_number: paymentAccount,
      debit_amount: toFormAmount(amount + roundingDelta),
      credit_amount: '',
      line_description: desc,
    })
    lines.push({
      account_number: '1510',
      debit_amount: '',
      credit_amount: toFormAmount(amount),
      line_description: desc,
    })
    if (roundingDelta !== 0) {
      lines.push(oreRoundingLine(roundingDelta))
    }
  }

  return lines
}

function proposeCashLines(
  invoice: ProposePaymentLinesInput['invoice'],
  paymentAccount: string,
  desc: string,
  entityType: EntityType,
  roundingDelta = 0,
  deductionSek = 0
): FormLine[] {
  const lines: FormLine[] = []
  const isForeign = invoice.currency !== 'SEK'

  // The cash-method preview IS the entry: PaymentBookingDialog submits these
  // lines verbatim. A foreign invoice with no rate therefore must not be
  // pre-filled with the raw foreign numbers relabelled as kronor: refuse with
  // the same error the server generator raises (createInvoiceCashEntry). The
  // dialog resolves the proposal inside a try/catch and surfaces the refusal as
  // a translated toast, so throwing here is a visible dead-end, not a crash.
  const toSek = (amount: number): number => {
    const sek = resolveSekAmountOrNull(amount, null, invoice.currency, invoice.exchange_rate)
    if (sek === null) throw new InvoiceFxRateMissingError(invoice.currency)
    return sek
  }

  // Build credit lines per VAT rate group. Free-text / blank rows carry no
  // amounts and never book: drop them first.
  const creditLines: FormLine[] = []
  const billableItems = (invoice.items ?? []).filter((item) => item.line_type !== 'text')

  if (billableItems.length > 0) {
    const hasPerLineVat = billableItems.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)

    if (!hasPerLineVat) {
      // Legacy: single rate from invoice level
      const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
      const subtotal = billableItems.reduce((sum, item) => sum + item.line_total, 0)
      creditLines.push({
        account_number: revenueAccount,
        debit_amount: '',
        credit_amount: toFormAmount(toSek(subtotal)),
        line_description: (invoice.invoice_number ? `Försäljning faktura ${invoice.invoice_number}` : 'Försäljning faktura'),
      })

      const totalVat = billableItems.reduce((sum, item) => sum + (item.vat_amount || 0), 0)
      if (totalVat > 0) {
        const vatAccount = getOutputVatAccount(invoice.vat_treatment)
        creditLines.push({
          account_number: vatAccount,
          debit_amount: '',
          credit_amount: toFormAmount(toSek(totalVat)),
          line_description: 'Utgående moms',
        })
      }
    } else {
      // Group items by vat_rate
      const rateGroups = new Map<number, { subtotal: number; vatAmount: number }>()
      for (const item of billableItems) {
        const rate = item.vat_rate ?? 0
        const group = rateGroups.get(rate) || { subtotal: 0, vatAmount: 0 }
        group.subtotal += item.line_total
        group.vatAmount += item.vat_amount || 0
        rateGroups.set(rate, group)
      }

      for (const [rate, group] of rateGroups) {
        const treatment = rate === 0 && (invoice.vat_treatment === 'reverse_charge' || invoice.vat_treatment === 'export')
          ? invoice.vat_treatment
          : getVatTreatmentForRate(rate)
        const revenueAccount = getRevenueAccount(treatment, entityType)

        creditLines.push({
          account_number: revenueAccount,
          debit_amount: '',
          credit_amount: toFormAmount(Math.round(toSek(group.subtotal) * 100) / 100),
          line_description: (invoice.invoice_number ? `Försäljning faktura ${invoice.invoice_number}` : 'Försäljning faktura'),
        })

        const roundedVat = Math.round(toSek(group.vatAmount) * 100) / 100
        if (roundedVat !== 0) {
          const vatAccount = getOutputVatAccount(treatment)
          creditLines.push({
            account_number: vatAccount,
            debit_amount: '',
            credit_amount: toFormAmount(roundedVat),
            line_description: `Utgående moms ${rate}%`,
          })
        }
      }
    }
  } else {
    // Fallback: invoice-level amounts
    const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
    const subtotalSek = resolveSekAmount(invoice.subtotal, invoice.subtotal_sek, invoice.currency, invoice.exchange_rate)
    creditLines.push({
      account_number: revenueAccount,
      debit_amount: '',
      credit_amount: toFormAmount(subtotalSek),
      line_description: (invoice.invoice_number ? `Försäljning faktura ${invoice.invoice_number}` : 'Försäljning faktura'),
    })

    if (invoice.vat_amount > 0) {
      const vatSek = resolveSekAmount(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
      const vatAccount = getOutputVatAccount(invoice.vat_treatment)
      creditLines.push({
        account_number: vatAccount,
        debit_amount: '',
        credit_amount: toFormAmount(vatSek),
        line_description: (invoice.invoice_number ? `Utgående moms faktura ${invoice.invoice_number}` : 'Utgående moms faktura'),
      })
    }
  }

  // Debit: balance guarantee
  const totalCredits = creditLines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const debitAmount = isForeign
    ? Math.round(totalCredits * 100) / 100
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)

  // Cash method: revenue + moms on the full amount, but the bank only ever
  // receives the customer's share; the ROT/RUT deduction is debited to 1513
  // (Skatteverket pays it later), mirroring createInvoiceCashEntry.
  lines.push({
    account_number: paymentAccount,
    debit_amount: toFormAmount(debitAmount - deductionSek + roundingDelta),
    credit_amount: '',
    line_description: desc,
  })
  if (deductionSek > 0) {
    lines.push({
      account_number: '1513',
      debit_amount: toFormAmount(deductionSek),
      credit_amount: '',
      line_description: invoice.invoice_number
        ? `ROT/RUT-avdrag faktura ${invoice.invoice_number}`
        : 'ROT/RUT-avdrag faktura',
    })
  }

  lines.push(...creditLines)

  if (roundingDelta !== 0) {
    lines.push(oreRoundingLine(roundingDelta))
  }

  return lines
}
