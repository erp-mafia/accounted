import { describe, expect, it } from 'vitest'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { buildCreditNoteFields, creditedAmount } from '@/lib/invoices/build-credit-note'
import type { Invoice, InvoiceItem } from '@/types'

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

  it('prints the article number the original printed (crm#1084)', () => {
    expect(buildCreditNoteItem('credit-1', item({ article_id: 'art-1', article_number: 'A-100' }))).toMatchObject({
      article_id: 'art-1',
      article_number: 'A-100',
    })
    expect(buildCreditNoteItem('credit-1', item()).article_number).toBeNull()
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

  it('turns a rabatt row around: it comes back positive, the face arithmetic intact (accounted#58)', () => {
    // A rabatt keyed as a negative price: 1 x -100.
    expect(buildCreditNoteItem('credit-1', item({ quantity: 1, unit_price: -100, line_total: -100, vat_amount: -25 }))).toMatchObject({
      quantity: -1,
      unit_price: -100,
      line_total: 100,
      vat_amount: 25,
    })
    // The same rabatt keyed as a negative quantity: -1 x 100.
    expect(buildCreditNoteItem('credit-1', item({ quantity: -1, unit_price: 100, line_total: -100, vat_amount: -25 }))).toMatchObject({
      quantity: 1,
      unit_price: 100,
      line_total: 100,
      vat_amount: 25,
    })
  })

  it('writes rows that add up to the credit note header (accounted#58)', () => {
    const items = [
      item({ quantity: 1, unit_price: 1000, line_total: 1000, vat_amount: 250 }),
      item({ id: 'item-2', description: 'Rabatt', quantity: 1, unit_price: -100, line_total: -100, vat_amount: -25 }),
    ]
    const original = { id: 'invoice-1', subtotal: 900, vat_amount: 225, total: 1125, items } as unknown as Invoice
    const header = buildCreditNoteFields(original, { originalReference: 'F-1', today: '2026-10-19' })
    const rows = items.map((row) => buildCreditNoteItem('credit-1', row))

    expect(header).toMatchObject({ subtotal: -900, vat_amount: -225, total: -1125 })
    expect(rows.reduce((sum, row) => sum + row.line_total, 0)).toBe(header.subtotal)
    expect(rows.reduce((sum, row) => sum + row.vat_amount, 0)).toBe(header.vat_amount)
  })

  it('never writes -0 for a zero or missing amount', () => {
    const result = buildCreditNoteItem('credit-1', item({ line_type: 'text', quantity: 0, line_total: 0, vat_amount: null as unknown as number }))
    expect(Object.is(result.quantity, 0)).toBe(true)
    expect(Object.is(result.line_total, 0)).toBe(true)
    expect(Object.is(result.vat_amount, 0)).toBe(true)
    expect(Object.is(creditedAmount(undefined), 0)).toBe(true)
  })
})
