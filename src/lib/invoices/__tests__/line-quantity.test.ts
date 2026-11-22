import { describe, it, expect } from 'vitest'
import { lineQuantityIssue } from '@/lib/invoices/line-quantity'

describe('lineQuantityIssue (#3553)', () => {
  it('accepts a positive, zero or negative quantity on a plain row', () => {
    expect(lineQuantityIssue({ quantity: 3 })).toBeNull()
    expect(lineQuantityIssue({ quantity: 0 })).toBeNull()
    expect(lineQuantityIssue({ quantity: -2 })).toBeNull()
  })

  it('refuses a quantity that is not a number', () => {
    expect(lineQuantityIssue({ quantity: Number.NaN })).toBe('not_a_number')
    expect(lineQuantityIssue({ quantity: Number.POSITIVE_INFINITY })).toBe('not_a_number')
    expect(lineQuantityIssue({ quantity: null })).toBe('not_a_number')
    expect(lineQuantityIssue({})).toBe('not_a_number')
  })

  it('keeps a skattereduktion row positive: its claim sums positive rows only', () => {
    for (const deduction_type of ['rot', 'rut', 'gron_teknik']) {
      expect(lineQuantityIssue({ quantity: -2, deduction_type })).toBe('deduction_needs_positive')
      expect(lineQuantityIssue({ quantity: 0, deduction_type })).toBe('deduction_needs_positive')
      expect(lineQuantityIssue({ quantity: 1, deduction_type })).toBeNull()
    }
  })

  it('refuses a negative quantity on a sales order row, not a zero one', () => {
    expect(lineQuantityIssue({ quantity: -1, sales_order_item_id: 'soi-1' })).toBe('negative_on_order_line')
    expect(lineQuantityIssue({ quantity: 0, sales_order_item_id: 'soi-1' })).toBeNull()
  })
})
