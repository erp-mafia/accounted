import { describe, it, expect } from 'vitest'
import { compareCustomerNumbers } from '@/lib/customers/sort'

// Rows, not bare values: Array.prototype.sort hoists literal `undefined`
// elements to the end without ever calling the comparator, which would make a
// list of raw strings a test of the engine rather than of the comparator.
function sortRows(numbers: Array<string | null | undefined>): Array<string | null | undefined> {
  return numbers
    .map((customer_number) => ({ customer_number }))
    .sort((a, b) => compareCustomerNumbers(a.customer_number, b.customer_number))
    .map((row) => row.customer_number)
}

describe('compareCustomerNumbers', () => {
  it('orders numerically, not alphabetically', () => {
    expect(sortRows(['10', '2', '1'])).toEqual(['1', '2', '10'])
  })

  it('puts customers without a number last', () => {
    expect(sortRows([null, '7', undefined, '3'])).toEqual(['3', '7', null, undefined])
  })

  it('treats a blank number as no number', () => {
    expect(sortRows(['  ', '1'])).toEqual(['1', '  '])
  })

  it('handles prefixed numbers with embedded digits', () => {
    expect(sortRows(['K-10', 'K-2'])).toEqual(['K-2', 'K-10'])
  })

  it('reports equal numbers as a tie so the surrounding sort stays stable', () => {
    expect(compareCustomerNumbers('1001', '1001')).toBe(0)
    expect(compareCustomerNumbers(null, undefined)).toBe(0)
  })
})
