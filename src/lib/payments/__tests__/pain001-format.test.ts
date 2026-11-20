/**
 * The pain.001 value rules both payment files share (lib/payments/pain001-format.ts).
 */
import { describe, it, expect } from 'vitest'
import { formatPainAmount, max35, painControlSum, suffixId } from '../pain001-format'

describe('pain001-format', () => {
  it('renders an amount to öre with a dot separator', () => {
    expect(formatPainAmount(25500)).toBe('25500.00')
    expect(formatPainAmount(1234.565)).toBe('1234.57')
    expect(formatPainAmount(0.1 + 0.2)).toBe('0.30')
  })

  it('sums the amounts as rendered, so the control sum equals the sum of the InstdAmt values', () => {
    // Three amounts that each round up: summing raw and rounding once gives
    // 30.01; the bank adds the rendered 10.01 three times and wants 30.03.
    const amounts = [10.005, 10.005, 10.005]
    const rendered = amounts.map(formatPainAmount)
    expect(rendered).toEqual(['10.01', '10.01', '10.01'])
    expect(formatPainAmount(painControlSum(amounts))).toBe('30.03')
  })

  it('keeps ids within Max35Text and the suffix intact', () => {
    expect(max35('x'.repeat(40))).toHaveLength(35)
    const id = suffixId('L'.repeat(40), '-TX0001')
    expect(id).toHaveLength(35)
    expect(id.endsWith('-TX0001')).toBe(true)
  })
})
