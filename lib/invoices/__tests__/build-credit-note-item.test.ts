import { describe, expect, it } from 'vitest'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import type { InvoiceItem } from '@/types'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Arbete',
    quantity: 2,
    unit: 'tim',
    unit_price: 1000,
    line_total: 2000,
    vat_rate: 25,
    vat_amount: 500,
    created_at: '2026-07-14T00:00:00Z',
    ...overrides,
  }
}

describe('buildCreditNoteItem', () => {
  it('negates amounts, keeps the deduction magnitude positive, and preserves ROT/RUT, account, accrual, and dimension metadata', () => {
    const result = buildCreditNoteItem('credit-1', item({
      deduction_type: 'rot',
      deduction_amount: 600,
      labor_hours: 2,
      work_type: 'BYGG',
      housing_designation: 'Test 1:2',
      revenue_account: '3041',
      accrual_period_start: '2026-07-01',
      accrual_period_end: '2026-12-31',
      accrual_balance_account: '2970',
      dimensions: { '6': 'P001' },
    }))

    expect(result).toMatchObject({
      invoice_id: 'credit-1',
      quantity: -2,
      line_total: -2000,
      vat_amount: -500,
      deduction_type: 'rot',
      // Positive magnitude: invoice_items has CHECK (deduction_amount >= 0).
      deduction_amount: 600,
      labor_hours: 2,
      work_type: 'BYGG',
      housing_designation: 'Test 1:2',
      revenue_account: '3041',
      accrual_period_start: '2026-07-01',
      accrual_period_end: '2026-12-31',
      accrual_balance_account: '2970',
      dimensions: { '6': 'P001' },
    })
  })
})
