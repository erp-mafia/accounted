/**
 * Pure function to compute proposed journal entry lines for an invoice payment.
 * Used by the PaymentBookingDialog to pre-fill the editable line grid.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { resolveSekAmount, resolveSekAmountOrNull } from './currency-utils'
import { roundOre, ORE_TOLERANCE, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { InvoiceFxRateMissingError } from './invoice-accounts'
import { buildInvoiceCashLines } from './invoice-lines'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { EntityType, InvoiceItem, VatTreatment } from '@/types'

export interface ProposePaymentLinesInput {
  invoice: {
    id: string
    invoice_number: string | null
    /** The customer's name, for the payment line text as the other doors book it. */
    customer_name?: string | null
    total: number
    total_sek?: number | null
    subtotal: number
    subtotal_sek?: number | null
    vat_amount: number
    vat_amount_sek?: number | null
    currency: string
    exchange_rate?: number | null
    vat_treatment: VatTreatment
    /** #2906: goods delivered abroad preview on 3105 / 3108, as they book. */
    delivery_country?: string | null
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
     * The part of the deduction Skatteverket refused and that a
     * rot_rut_reclaim voucher moved back onto the customer (debit 1510).
     * When set, the invoice's remaining is a plain 1510 fordran again and the
     * remaining-aware proposal applies to it.
     */
    deduction_reclaimed_total?: number | null
    /**
     * Dimensions PR7: the invoice's default bag. The payment dialog always
     * submits its (editable) lines, so the preview IS the booked entry and
     * must carry the tag like the generator path does: stamped on every
     * clearing line; on the kontantmetoden entry each line carries the bag
     * buildInvoiceCashLines gives it (an item's own tag merged over this one).
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
 * Cash: the kontantmetoden entry of buildInvoiceCashLines (see proposeCashLines).
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

  if (accountingMethod === 'cash') {
    return proposeCashLines(invoice, paymentAccount, entityType, roundingDelta)
  }

  // 1513 is a kronor receivable, so the deduction converts with the invoice's
  // booking rate or not at all: same refusal as generateRotRutLines.
  const deductionSek = resolveDeductionSek(invoice)

  return withInvoiceDimensions(
    proposeAccrualLines(invoice, paymentAccount, desc, exchangeRateDifference, roundingDelta, deductionSek),
    invoice,
  )
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
 *     payout flow, not by clearing 1510 here. The one exception is a
 *     deduction Skatteverket refused: the reclaim voucher has already moved
 *     that share onto 1510 (deduction_reclaimed_total > 0), so the reopened
 *     remaining is an ordinary customer fordran and is proposed as such.
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
  const reclaimed = invoice.deduction_reclaimed_total ?? 0
  if ((invoice.deduction_total ?? 0) > 0 && !(reclaimed > 0)) return null

  // With a reclaimed deduction the customer's whole fordran is total minus
  // the deduction plus the refused share; "partial" is measured against
  // that, not the printed total.
  const total = roundOre(invoice.total - (invoice.deduction_total ?? 0) + reclaimed)
  const remaining = roundOre(
    invoice.remaining_amount ?? total - (invoice.paid_amount ?? 0),
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

/**
 * The kontantmetoden proposal. PaymentBookingDialog submits these lines
 * verbatim, so they come from buildInvoiceCashLines, the builder
 * createInvoiceCashEntry books on every other door (bank match, v1, MCP).
 * This used to be a hand-kept copy that had drifted from it: it credited the
 * VAT rate's default account where an invoice line named its own (an artikel
 * or line override on 3041, say, was proposed and booked on 3001), and split
 * neither per-item dimension bags nor per-item 1513 lines. A foreign invoice
 * with no rate makes the builder refuse (InvoiceFxRateMissingError) instead
 * of relabelling the foreign numbers as kronor; the dialog shows it as a toast.
 *
 * The one thing added on top is öresavrundning: the customer pays the rounded
 * "Att betala", so the bank leg is that amount and 3740 carries the residual.
 */
function proposeCashLines(
  invoice: ProposePaymentLinesInput['invoice'],
  paymentAccount: string,
  entityType: EntityType,
  roundingDelta = 0,
): FormLine[] {
  const { lines } = buildInvoiceCashLines(
    invoice,
    entityType,
    invoice.customer_name ?? undefined,
    paymentAccount,
  )
  const formLines: FormLine[] = lines.map((line) => ({
    account_number: line.account_number,
    debit_amount: toFormAmount(line.debit_amount),
    credit_amount: toFormAmount(line.credit_amount),
    line_description: line.line_description ?? '',
    ...(line.dimensions && Object.keys(line.dimensions).length > 0
      ? { dimensions: { ...line.dimensions } }
      : {}),
  }))

  if (roundingDelta !== 0) {
    // The builder's first line is the settlement debit.
    const bank = lines[0]
    formLines[0] = { ...formLines[0], debit_amount: toFormAmount(bank.debit_amount + roundingDelta) }
    const [ore] = withInvoiceDimensions([oreRoundingLine(roundingDelta)], invoice)
    formLines.push(ore)
  }

  return formLines
}
