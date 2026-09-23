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

  it('carries discount_percent so the kreditfaktura face arithmetic multiplies out', () => {
    // Original: 2 x 1000 with 10% rabatt → net 1800. The credit row must keep
    // the discount, or -2 x 1000 next to Summa -1800 prints with no visible
    // prisnedsättning (ML 17 kap 24 §) and violates the stored net invariant.
    const result = buildCreditNoteItem('credit-1', item({ discount_percent: 10, line_total: 1800, vat_amount: 450 }))
    expect(result).toMatchObject({
      quantity: -2,
      discount_percent: 10,
      line_total: -1800,
      vat_amount: -450,
    })
    // Legacy rows without the column default to 0.
    expect(buildCreditNoteItem('credit-1', item()).discount_percent).toBe(0)
  })
})
