/**
 * Pure function to compute proposed journal entry lines for sending an invoice.
 * Used by the SendInvoiceDialog to preview the journal entry before committing.
 *
 * No DB or Supabase dependency: all inputs are plain data.
 */
import { resolveSekAmount, resolveSekAmountOrNull } from './currency-utils'
import {
  getRevenueAccount,
  getOutputVatAccount,
  InvoiceFxRateMissingError,
} from './invoice-accounts'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import { computeDeduction } from '@/lib/invoices/rot-rut-rules'
import { roundOre } from '@/lib/money'
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
    credited_invoice_id?: string | null
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
  const proposedLines = invoice.credited_invoice_id
    ? buildCreditNoteLines(invoice, entityType)
    : buildSendLines(invoice, entityType)
  const lines: FormLine[] = stampProposalDimensions(
    proposedLines,
    invoice.default_dimensions
  )
  return lines
}

function absoluteOptional(amount: number | null | undefined): number | null | undefined {
  return amount == null ? amount : Math.abs(amount)
}

function buildCreditNoteLines(
  invoice: ProposeSendLinesInput['invoice'],
  entityType: EntityType,
): FormLine[] {
  const absoluteInvoice: ProposeSendLinesInput['invoice'] = {
    ...invoice,
    total: Math.abs(invoice.total),
    total_sek: absoluteOptional(invoice.total_sek),
    subtotal: Math.abs(invoice.subtotal),
    subtotal_sek: absoluteOptional(invoice.subtotal_sek),
    vat_amount: Math.abs(invoice.vat_amount),
    vat_amount_sek: absoluteOptional(invoice.vat_amount_sek),
    items: invoice.items?.map((item) => ({
      ...item,
      quantity: Math.abs(item.quantity),
      line_total: Math.abs(item.line_total),
      vat_amount: item.vat_amount == null ? item.vat_amount : Math.abs(item.vat_amount),
    })),
  }

  return buildSendLines(absoluteInvoice, entityType).map((line) => ({
    ...line,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: line.line_description
      .replace('Försäljning faktura', 'Kreditfaktura')
      .replace('Utgående moms faktura', 'Moms kreditfaktura')
      .replace('Utgående moms', 'Moms kreditfaktura'),
  }))
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
    const sek = resolveSekAmountOrNull(amount, null, invoice.currency, invoice.exchange_rate)
    // Unreachable behind the fxUnconvertible bail below; kept as an assertion so
    // removing that bail fails loudly instead of silently relabelling foreign
    // amounts as kronor.
    if (sek === null) throw new InvoiceFxRateMissingError(invoice.currency)
    return sek
  }

  // Build credit lines per VAT rate group
  const creditLines: FormLine[] = []
  const accountingItems = (invoice.items ?? []).filter((item) => item.line_type !== 'text')

  // Existing informational rows are never a valid source for an invoice-level
  // amount. Returning no proposal keeps an inconsistent text-only invoice from
  // producing a debit-only entry; the user must correct its economic rows.
  if (accountingItems.length === 0 && (invoice.items?.length ?? 0) > 0) {
    return []
  }

  // Item-driven legs have only `exchange_rate` to convert with: an InvoiceItem
  // carries no per-item SEK column. Without a rate every proposed leg would be
  // the raw foreign number relabelled as kronor, and because the 1510 debit is
  // derived from the sum of the credits the grid would even read "Balanserar".
  // Return no proposal (the same signal used just above for a text-only invoice)
  // so the dialog hides the journal preview rather than displaying fabricated
  // amounts. The send itself still routes through createInvoiceJournalEntry,
  // which refuses this case outright with INVOICE_FX_RATE_MISSING.
  //
  // Why bail instead of throwing the way propose-payment-lines does:
  // proposeSendLines runs inside a useMemo during SendInvoiceDialog's render,
  // where a throw takes out the page instead of producing a toast. `editable` is
  // SEK-only, so an empty proposal cannot disable the submit button either.
  // Scoped to the item path on purpose: the invoice-level fallback below has a
  // genuine second source (subtotal_sek / vat_amount_sek) and is left alone.
  const fxUnconvertible = isForeign && !(invoice.exchange_rate != null && invoice.exchange_rate > 0)
  if (accountingItems.length > 0 && fxUnconvertible) {
    return []
  }

  if (accountingItems.length > 0) {
    const hasPerLineVat = accountingItems.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)

    if (!hasPerLineVat) {
      // Legacy: single rate from invoice level
      const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
      const subtotal = accountingItems.reduce((sum, item) => sum + item.line_total, 0)
      creditLines.push({
        account_number: revenueAccount,
        debit_amount: '',
        credit_amount: toFormAmount(toSek(subtotal)),
        line_description: desc,
      })

      const totalVat = accountingItems.reduce((sum, item) => sum + (item.vat_amount || 0), 0)
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
      for (const item of accountingItems) {
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
  } else if (!invoice.items || invoice.items.length === 0) {
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

  const deductionLines: FormLine[] = []
  let deductionTotal = 0
  for (const item of accountingItems) {
    if (!item.deduction_type) continue
    const deduction = computeDeduction({
      unit_price: item.unit_price,
      quantity: item.quantity,
      deduction_type: item.deduction_type,
      vat_rate: item.vat_rate,
    })
    const amountSek = roundOre(toSek(deduction))
    if (amountSek <= 0) continue
    deductionTotal = roundOre(deductionTotal + amountSek)
    deductionLines.push({
      account_number: '1513',
      debit_amount: toFormAmount(amountSek),
      credit_amount: '',
      line_description: `${item.deduction_type === 'rot' ? 'ROT' : 'RUT'}-avdrag faktura ${invoice.invoice_number ?? ''}`.trim(),
    })
  }

  // Text-only and other informational invoice rows carry zero totals. They
  // must not become misleading 30xx rows in the booking preview.
  const nonZeroCreditLines = creditLines.filter(
    (line) => roundOre(parseFloat(line.credit_amount) || 0) !== 0,
  )

  // Debit: 1510 customer portion plus 1513 Skatteverket portion.
  const totalCredits = nonZeroCreditLines.reduce(
    (sum, line) => sum + (parseFloat(line.credit_amount) || 0),
    0,
  )
  const debitAmount = isForeign
    ? Math.round(totalCredits * 100) / 100
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
  const customerReceivable = roundOre(debitAmount - deductionTotal)

  if (customerReceivable === 0 && deductionLines.length === 0 && nonZeroCreditLines.length === 0) {
    return []
  }

  lines.push({
    account_number: '1510',
    debit_amount: toFormAmount(customerReceivable),
    credit_amount: '',
    line_description: desc,
  })

  lines.push(...deductionLines)
  lines.push(...nonZeroCreditLines)

  return lines
}
