import { proposeSendLines } from '@/lib/bookkeeping/propose-send-lines'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-lines'
import { computeLineNet, computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { roundOre } from '@/lib/money'
import {
  buildCreditNoteFields,
  creditNoteNumber,
  creditNoteOriginalReference,
} from '@/lib/invoices/build-credit-note'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type { DeductionType, EntityType, Invoice, InvoiceItem, VatTreatment } from '@/types'

/**
 * The verifikation the editor's send confirm shows before anything exists:
 * the same proposal SendInvoiceDialog shows for a saved draft
 * (proposeSendLines), fed from the form instead of a stored invoice. Display
 * only: the send route books through the generator.
 */

export interface DraftVoucherItem {
  line_type?: 'product' | 'text' | null
  quantity?: number | null
  unit_price?: number | null
  discount_percent?: number | null
  vat_rate?: number | null
  deduction_type?: DeductionType | null
  work_type?: string | null
}

export interface DraftVoucherInput {
  invoiceNumber: string | null
  currency: string
  /** The invoice's header treatment (the customer's VAT rule). */
  vatTreatment: VatTreatment
  /** A non-momsregistrerad seller charges no VAT: every rate is 0. */
  vatRegistered: boolean
  /** The rate a line without one falls back to (the customer default). */
  defaultVatRate: number
  items: DraftVoucherItem[]
  defaultDimensions?: Record<string, string> | null
  entityType: EntityType
}

/**
 * Proposed lines, or [] when there is nothing to show: no priced rows, or a
 * foreign currency (the SEK amounts need the rate the send fetches; the
 * dialog says so instead of showing kronor it cannot know).
 */
export function proposeDraftSendLines(input: DraftVoucherInput): FormLine[] {
  const invoice = draftInvoice(input)
  if (!invoice) return []
  return proposeSendLines({ invoice, entityType: input.entityType })
}

/**
 * The kontantfaktura's one verifikat (crm#1281), shown by the editor's
 * "Redan betald" confirm before anything exists: the payment account debit
 * against revenue and output VAT, from buildInvoiceCashLines, the generator
 * the payment at issue books with. [] under the same conditions as
 * proposeDraftSendLines. `options.deferDeductionShare` as the payment passes
 * it: true for a kontantmetod company (a ROT/RUT invoice's two steps).
 */
export function proposeDraftCashLines(
  input: DraftVoucherInput,
  settlementAccountNumber: string,
  options: { deferDeductionShare?: boolean } = {},
): Array<{ account_number: string; debit_amount: number; credit_amount: number }> {
  const invoice = draftInvoice(input)
  if (!invoice) return []
  return buildInvoiceCashLines(invoice, input.entityType, undefined, settlementAccountNumber, undefined, undefined, options)
    .lines.filter((line) => roundOre(line.debit_amount) !== 0 || roundOre(line.credit_amount) !== 0)
    .map((line) => ({
      account_number: line.account_number,
      debit_amount: roundOre(line.debit_amount),
      credit_amount: roundOre(line.credit_amount),
    }))
}

/** The form as a stored invoice row, or null when it cannot be stated in kronor or prices nothing. */
function draftInvoice(input: DraftVoucherInput) {
  if (input.currency !== 'SEK') return null
  const items = input.items.map((item, index): InvoiceItem => {
    const isText = item.line_type === 'text'
    const quantity = isText ? 0 : Number(item.quantity) || 0
    const unitPrice = isText ? 0 : Number(item.unit_price) || 0
    const discount = item.discount_percent ?? null
    const rate = input.vatRegistered ? item.vat_rate ?? input.defaultVatRate : 0
    // The write path's arithmetic (build-invoice-write): net of the line
    // discount, VAT rounded per line.
    const lineTotal = computeLineNet(quantity, unitPrice, discount)
    return {
      id: `draft-${index}`,
      invoice_id: 'draft',
      sort_order: index,
      line_type: isText ? 'text' : 'product',
      description: '',
      quantity,
      unit: '',
      unit_price: unitPrice,
      discount_percent: discount ?? undefined,
      line_total: lineTotal,
      vat_rate: rate,
      vat_amount: computeLineVat(lineTotal, rate),
      deduction_type: item.deduction_type ?? null,
      work_type: item.work_type ?? null,
    } as InvoiceItem
  })
  const priced = items.filter((item) => item.line_type !== 'text')
  if (priced.length === 0) return null
  const subtotal = roundOre(priced.reduce((sum, item) => sum + item.line_total, 0))
  const vatAmount = roundOre(priced.reduce((sum, item) => sum + item.vat_amount, 0))
  return {
    id: 'draft',
    invoice_number: input.invoiceNumber,
    total: roundOre(subtotal + vatAmount),
    subtotal,
    vat_amount: vatAmount,
    currency: input.currency,
    vat_treatment: input.vatTreatment,
    items,
    default_dimensions: input.defaultDimensions ?? null,
  }
}

/**
 * The reversal the credit page's confirm shows: the kreditfaktura POST
 * /api/invoices creates for this invoice (buildCreditNoteFields and
 * buildCreditNoteItem, the same derivation as the create route and the
 * credit preview), proposed the way SendInvoiceDialog proposes it for a
 * saved credit note. [] when it cannot be stated in kronor before it exists
 * (a foreign-currency original without its rate) or the original has no
 * number to refer to.
 */
export function proposeCreditNoteSendLines(
  original: Invoice & { items: InvoiceItem[] },
  options: { entityType: EntityType; today: string },
): FormLine[] {
  const reference = creditNoteOriginalReference(original)
  if (!reference) return []
  const fields = buildCreditNoteFields(original, { originalReference: reference, today: options.today })
  const items = original.items.map(
    (item, index) => ({ ...buildCreditNoteItem('credit-preview', item), id: `credit-${index}` }) as InvoiceItem,
  )
  try {
    return proposeSendLines({
      invoice: {
        id: 'credit-preview',
        invoice_number: creditNoteNumber(reference),
        total: fields.total,
        total_sek: fields.total_sek,
        subtotal: fields.subtotal,
        subtotal_sek: fields.subtotal_sek,
        vat_amount: fields.vat_amount,
        vat_amount_sek: fields.vat_amount_sek,
        currency: fields.currency,
        exchange_rate: fields.exchange_rate,
        vat_treatment: fields.vat_treatment,
        delivery_country: fields.delivery_country,
        credited_invoice_id: fields.credited_invoice_id,
        items,
        default_dimensions: fields.default_dimensions,
      },
      entityType: options.entityType,
    })
  } catch {
    // A missing FX rate on a foreign original: the confirm says how it books instead.
    return []
  }
}
