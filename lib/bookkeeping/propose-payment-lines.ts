/**
 * Pure function to compute proposed journal entry lines for an invoice payment.
 * Used by the PaymentBookingDialog to pre-fill the editable line grid.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { resolveSekAmount } from './currency-utils'
import { getRevenueAccount, getOutputVatAccount } from './invoice-entries'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
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
    /**
     * Dimensions PR7: the invoice's default bag. Stamped on every proposed
     * line: the payment dialog always submits its (editable) lines, so the
     * preview IS the booked entry and must re-propagate the tag like the
     * no-override generator path does. Per-item bags are not split out here
     * (the preview groups per rate); users can retag lines in the grid.
     */
    default_dimensions?: Record<string, string> | null
  }
  accountingMethod: 'accrual' | 'cash'
  entityType: EntityType
  paymentAccount?: string
  exchangeRateDifference?: number
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

  const lines = accountingMethod === 'accrual'
    ? proposeAccrualLines(invoice, paymentAccount, desc, exchangeRateDifference)
    : proposeCashLines(invoice, paymentAccount, desc, entityType)

  // Dimensions PR7: re-propagate the invoice default onto every proposed leg
  // (matches createInvoicePaymentJournalEntry/createInvoiceCashEntry).
  const bag = invoice.default_dimensions
  if (bag && Object.keys(bag).length > 0) {
    return lines.map((line) => ({ ...line, dimensions: { ...bag } }))
  }
  return lines
}

function proposeAccrualLines(
  invoice: ProposePaymentLinesInput['invoice'],
  paymentAccount: string,
  desc: string,
  exchangeRateDifference?: number
): FormLine[] {
  const bookedSekAmount = resolveSekAmount(
    invoice.total,
    invoice.total_sek,
    invoice.currency,
    invoice.exchange_rate
  )
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
      debit_amount: toFormAmount(amount),
      credit_amount: '',
      line_description: desc,
    })
    lines.push({
      account_number: '1510',
      debit_amount: '',
      credit_amount: toFormAmount(amount),
      line_description: desc,
    })
  }

  return lines
}

function proposeCashLines(
  invoice: ProposePaymentLinesInput['invoice'],
  paymentAccount: string,
  desc: string,
  entityType: EntityType
): FormLine[] {
  const lines: FormLine[] = []
  const isForeign = invoice.currency !== 'SEK'

  const toSek = (amount: number): number => {
    if (!isForeign) return amount
    if (invoice.exchange_rate != null && invoice.exchange_rate > 0) {
      return Math.round(amount * invoice.exchange_rate * 100) / 100
    }
    return amount
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

  lines.push({
    account_number: paymentAccount,
    debit_amount: toFormAmount(debitAmount),
    credit_amount: '',
    line_description: desc,
  })

  lines.push(...creditLines)

  return lines
}
