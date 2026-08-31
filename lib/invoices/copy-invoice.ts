import type {
  Currency,
  Invoice,
  InvoiceDocumentType,
  InvoiceItem,
  InvoiceStatus,
} from '@/types'

const COPYABLE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'sent',
  'paid',
  'partially_paid',
  'overdue',
  'credited',
])

export type InvoiceCopySource = Invoice & { items: InvoiceItem[] }

export interface InvoiceCopyItem {
  line_type: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_percent: number
  vat_rate: number
  article_id: null
  revenue_account: string | null
  deduction_type: 'rot' | 'rut' | null
  labor_hours: number | null
  work_type: string | null
  housing_designation: null
  apartment_number: null
  brf_org_number: null
  accrual_period_start: null
  accrual_period_end: null
  accrual_balance_account: null
  dimensions: Record<string, string> | null
}

export interface InvoiceCopyInitial {
  source_invoice_number: string
  customer_id: string
  currency: Currency
  document_type: InvoiceDocumentType
  our_reference: string
  notes: string
  ore_rounding: boolean | null
  default_dimensions: Record<string, string>
  items: InvoiceCopyItem[]
}

export function canCopyInvoice(
  invoice: Pick<Invoice, 'status' | 'document_type' | 'credited_invoice_id' | 'is_self_billed'>,
): boolean {
  return (
    invoice.document_type === 'invoice' &&
    !invoice.credited_invoice_id &&
    !invoice.is_self_billed &&
    COPYABLE_STATUSES.has(invoice.status)
  )
}

/**
 * Builds a safe starting point for a new invoice draft.
 *
 * The copied data is limited to reusable commercial content. Identity,
 * lifecycle, payment, bookkeeping, date, accrual, and recipient-specific
 * ROT/RUT fields are deliberately absent or cleared.
 */
export function buildInvoiceCopyInitial(source: InvoiceCopySource): InvoiceCopyInitial {
  return {
    source_invoice_number: source.invoice_number ?? '',
    customer_id: source.customer_id,
    currency: source.currency,
    document_type: 'invoice',
    our_reference: source.our_reference ?? '',
    notes: source.notes ?? '',
    ore_rounding: source.ore_rounding,
    default_dimensions: source.default_dimensions ?? {},
    items: [...source.items]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        line_type: item.line_type ?? 'product',
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: item.unit_price,
        // Agreed price reduction is reusable commercial content, like the price.
        discount_percent: item.discount_percent ?? 0,
        vat_rate: item.vat_rate ?? 25,
        // A copied line keeps the frozen description and price, but is not
        // linked to a possibly changed or archived article preset.
        article_id: null,
        revenue_account: item.revenue_account ?? null,
        deduction_type: item.deduction_type ?? null,
        labor_hours: item.labor_hours ?? null,
        work_type: item.work_type ?? null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
        // Accrual dates belong to the original accounting period.
        accrual_period_start: null,
        accrual_period_end: null,
        accrual_balance_account: null,
        dimensions: item.dimensions && Object.keys(item.dimensions).length > 0
          ? item.dimensions
          : null,
      })),
  }
}
