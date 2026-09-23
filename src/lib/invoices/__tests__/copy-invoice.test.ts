import { describe, expect, it } from 'vitest'
import { makeInvoice } from '@/tests/helpers'
import { buildInvoiceCopyInitial, canCopyInvoice } from '@/lib/invoices/copy-invoice'
import type { InvoiceItem } from '@/types'

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Consulting',
    quantity: 2,
    unit: 'tim',
    unit_price: 1000,
    line_total: 2000,
    vat_rate: 25,
    vat_amount: 500,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('canCopyInvoice', () => {
  it.each(['sent', 'paid', 'partially_paid', 'overdue', 'credited'] as const)(
    'allows an issued ordinary invoice with status %s',
    (status) => {
      expect(canCopyInvoice(makeInvoice({ status }))).toBe(true)
    },
  )

  it('rejects drafts, credit notes, other document types, and self-billing invoices', () => {
    expect(canCopyInvoice(makeInvoice({ status: 'draft' }))).toBe(false)
    expect(canCopyInvoice(makeInvoice({ status: 'sent', credited_invoice_id: 'invoice-original' }))).toBe(false)
    expect(canCopyInvoice(makeInvoice({ status: 'sent', document_type: 'proforma' }))).toBe(false)
    expect(canCopyInvoice(makeInvoice({ status: 'sent', is_self_billed: true }))).toBe(false)
  })
})

describe('buildInvoiceCopyInitial', () => {
  it('copies reusable content and clears lifecycle-specific fields', () => {
    const source = makeInvoice({
      id: 'invoice-original',
      invoice_number: 'F-2026007',
      status: 'paid',
      invoice_date: '2026-01-01',
      due_date: '2026-01-31',
      delivery_date: '2025-12-20',
      your_reference: 'Old customer contact',
      our_reference: 'Seller contact',
      notes: 'Reusable terms',
      payment_link_url: 'https://example.com/old-payment',
      journal_entry_id: 'journal-1',
      ore_rounding: true,
      default_dimensions: { '1': 'KS01' },
    })
    const first = makeItem({
      sort_order: 1,
      article_id: 'article-1',
      revenue_account: '3041',
      deduction_type: 'rot',
      labor_hours: 2,
      work_type: 'BYGG',
      housing_designation: 'Old property',
      apartment_number: '1201',
      brf_org_number: '5560000000',
      accrual_period_start: '2026-01-01',
      accrual_period_end: '2026-06-30',
      accrual_balance_account: '2970',
      dimensions: { '6': 'P001' },
    })
    const second = makeItem({ id: 'item-2', sort_order: 0, description: 'First row' })

    const copy = buildInvoiceCopyInitial({ ...source, items: [first, second] })

    expect(copy).toMatchObject({
      source_invoice_number: 'F-2026007',
      customer_id: source.customer_id,
      currency: 'SEK',
      document_type: 'invoice',
      our_reference: 'Seller contact',
      notes: 'Reusable terms',
      ore_rounding: true,
      default_dimensions: { '1': 'KS01' },
    })
    expect(copy.items.map((item) => item.description)).toEqual(['First row', 'Consulting'])
    expect(copy.items[1]).toMatchObject({
      article_id: null,
      revenue_account: '3041',
      deduction_type: 'rot',
      labor_hours: 2,
      work_type: 'BYGG',
      housing_designation: null,
      apartment_number: null,
      brf_org_number: null,
      accrual_period_start: null,
      accrual_period_end: null,
      accrual_balance_account: null,
      dimensions: { '6': 'P001' },
    })
    expect(copy).not.toHaveProperty('invoice_date')
    expect(copy).not.toHaveProperty('due_date')
    expect(copy).not.toHaveProperty('your_reference')
    expect(copy).not.toHaveProperty('payment_link_url')
    expect(copy).not.toHaveProperty('journal_entry_id')
    expect(copy).not.toHaveProperty('status')
  })
})
