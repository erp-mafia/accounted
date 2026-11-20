import { describe, it, expect } from 'vitest'
import {
  compactDimensions,
  deductionsAvailable,
  defaultLaborHours,
  rowOptionBadges,
  shouldShowDeductionColumn,
  shouldShowVatColumn,
  type RowBadgeContext,
} from '@/lib/invoices/editor/rows'

describe('shouldShowVatColumn', () => {
  it('hides the column while every row carries the default rate', () => {
    expect(shouldShowVatColumn({ vatRegistered: true, defaultRate: 25, rates: [25, 25, null] })).toBe(false)
  })

  it('shows it once a row differs', () => {
    expect(shouldShowVatColumn({ vatRegistered: true, defaultRate: 25, rates: [25, 12] })).toBe(true)
    expect(shouldShowVatColumn({ vatRegistered: true, defaultRate: 0, rates: [25] })).toBe(true)
  })

  it('never shows it for a seller that is not VAT registered', () => {
    expect(shouldShowVatColumn({ vatRegistered: false, defaultRate: 25, rates: [12] })).toBe(false)
  })
})

describe('deductions', () => {
  it('are offered on a faktura to a private person only', () => {
    expect(deductionsAvailable({ isInvoiceDoc: true, customerType: 'individual' })).toBe(true)
    expect(deductionsAvailable({ isInvoiceDoc: true, customerType: 'swedish_business' })).toBe(false)
    expect(deductionsAvailable({ isInvoiceDoc: true, customerType: null })).toBe(false)
    expect(deductionsAvailable({ isInvoiceDoc: false, customerType: 'individual' })).toBe(false)
  })

  it('keep the Avdrag column for a row that already claims one', () => {
    expect(shouldShowDeductionColumn({ available: false, items: [{ deduction_type: 'rot' }] })).toBe(true)
    expect(shouldShowDeductionColumn({ available: false, items: [{ deduction_type: null }] })).toBe(false)
    expect(shouldShowDeductionColumn({ available: true, items: [] })).toBe(true)
  })
})

describe('rowOptionBadges', () => {
  const ctx: RowBadgeContext = {
    isSelfBilled: false,
    isInvoiceDoc: true,
    dimensionsEnabled: true,
    canUseAccrual: true,
  }

  it('gives a plain row no badge', () => {
    expect(rowOptionBadges({ line_type: 'product' }, ctx)).toEqual([])
  })

  it('badges every option set from the row menu, in menu order', () => {
    expect(
      rowOptionBadges(
        {
          line_type: 'product',
          discount_percent: 10,
          revenue_account: '3011',
          accrual_balance_account: '2970',
          accrual_period_start: '2026-10-01',
          accrual_period_end: '2027-03-31',
          dimensions: { '6': 'P001', '1': 'KS01' },
        },
        ctx,
      ),
    ).toEqual([
      { kind: 'discount', percent: 10 },
      { kind: 'accrual', months: 6 },
      { kind: 'account', account: '3011' },
      { kind: 'dimensions', dims: 'KS01 · P001' },
    ])
  })

  it('does not badge an account the row only inherits from its article', () => {
    expect(rowOptionBadges({ revenue_account: '3041' }, { ...ctx, articleAccount: '3041' })).toEqual([])
    expect(rowOptionBadges({ revenue_account: '3011' }, { ...ctx, articleAccount: '3041' })).toEqual([
      { kind: 'account', account: '3011' },
    ])
  })

  it('leaves out what the document cannot carry', () => {
    const item = { discount_percent: 5, revenue_account: '3011', dimensions: { '1': 'KS01' } }
    expect(rowOptionBadges(item, { ...ctx, isSelfBilled: true, isInvoiceDoc: false })).toEqual([])
    expect(rowOptionBadges({ line_type: 'text', discount_percent: 5 }, ctx)).toEqual([])
  })

  it('names an accrual with an unfinished period without a month count', () => {
    expect(rowOptionBadges({ accrual_balance_account: '2970', accrual_period_start: '2026-10-01' }, ctx)).toEqual([
      { kind: 'accrual', months: null },
    ])
  })
})

describe('compactDimensions', () => {
  it('joins the values in dimension-number order', () => {
    expect(compactDimensions({ '6': 'P001', '1': 'KS01' })).toBe('KS01 · P001')
    expect(compactDimensions(null)).toBe('')
  })
})

describe('defaultLaborHours', () => {
  it('takes the hours from a row billed by the hour', () => {
    expect(defaultLaborHours({ unit: 'tim', quantity: 6 })).toBe(6)
    expect(defaultLaborHours({ unit: ' H ', quantity: 2.5 })).toBe(2.5)
  })

  it('leaves other units and empty quantities to the user', () => {
    expect(defaultLaborHours({ unit: 'st', quantity: 6 })).toBeNull()
    expect(defaultLaborHours({ unit: 'tim', quantity: 0 })).toBeNull()
    expect(defaultLaborHours({ unit: 'tim', quantity: null })).toBeNull()
  })
})
