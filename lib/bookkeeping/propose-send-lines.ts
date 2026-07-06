/**
 * Pure function to compute proposed journal entry lines for sending an invoice.
 * Used by the SendInvoiceDialog to preview the journal entry before committing.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { resolveSekAmount } from './currency-utils'
import { getRevenueAccount, getOutputVatAccount } from './invoice-entries'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { EntityType, InvoiceItem, VatTreatment } from '@/types'

export interface ProposeSendLinesInput {
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
     * Dimensions PR7: the invoice's default bag, stamped on every proposed
     * line so the preview matches what createInvoiceJournalEntry books
     * (display-only, the send routes book via the generator).
     */
    default_dimensions?: Record<string, string> | null
  }
  entityType: EntityType
}

function toFormAmount(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return rounded === 0 ? '' : rounded.toString()
}

/**
 * Propose journal entry lines for an invoice send (accrual method).
 *
 * Debit  1510 Kundfordringar [total incl VAT]
 * Credit 30xx Försäljning    [subtotal per rate]
 * Credit 26xx Utgående moms  [VAT per rate]
 */
export function proposeSendLines(input: ProposeSendLinesInput): FormLine[] {
  const { invoice, entityType } = input
  const lines: FormLine[] = stampProposalDimensions(
    buildSendLines(invoice, entityType),
    invoice.default_dimensions
  )
  return lines
}

function stampProposalDimensions(
  lines: FormLine[],
  bag?: Record<string, string> | null
): FormLine[] {
  if (!bag || Object.keys(bag).length === 0) return lines
  return lines.map((line) => ({ ...line, dimensions: { ...bag } }))
}

function buildSendLines(
  invoice: ProposeSendLinesInput['invoice'],
  entityType: EntityType
): FormLine[] {
  const lines: FormLine[] = []
  const isForeign = invoice.currency !== 'SEK'
  const desc = invoice.invoice_number ? `Försäljning faktura ${invoice.invoice_number}` : 'Försäljning faktura'

  const toSek = (amount: number): number => {
    if (!isForeign) return amount
    if (invoice.exchange_rate != null && invoice.exchange_rate > 0) {
      return Math.round(amount * invoice.exchange_rate * 100) / 100
    }
    return amount
  }

  // Build credit lines per VAT rate group
  const creditLines: FormLine[] = []

  if (invoice.items && invoice.items.length > 0) {
    const hasPerLineVat = invoice.items.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)

    if (!hasPerLineVat) {
      // Legacy: single rate from invoice level
      const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
      const subtotal = invoice.items.reduce((sum, item) => sum + item.line_total, 0)
      creditLines.push({
        account_number: revenueAccount,
        debit_amount: '',
        credit_amount: toFormAmount(toSek(subtotal)),
        line_description: desc,
      })

      const totalVat = invoice.items.reduce((sum, item) => sum + (item.vat_amount || 0), 0)
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
      for (const item of invoice.items) {
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
          line_description: desc,
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
      line_description: desc,
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

  // Debit: 1510 Kundfordringar, balance guarantee
  const totalCredits = creditLines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
  const debitAmount = isForeign
    ? Math.round(totalCredits * 100) / 100
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)

  lines.push({
    account_number: '1510',
    debit_amount: toFormAmount(debitAmount),
    credit_amount: '',
    line_description: desc,
  })

  lines.push(...creditLines)

  return lines
}
