import { describe, it, expect } from 'vitest'
import { openingBalanceAmountText, openingBalanceDraftAmount } from '../amount-draft'

describe('openingBalanceDraftAmount', () => {
  it('reads every step of typing an amount with öre', () => {
    const steps: Array<[string, number]> = [
      ['1', 1],
      ['12', 12],
      ['125', 125],
      ['125,', 125],
      ['125,5', 125.5],
      ['125,50', 125.5],
    ]
    for (const [text, amount] of steps) {
      expect(openingBalanceDraftAmount(text)).toBe(amount)
    }
  })

  it('reads a decimal point like a decimal comma', () => {
    expect(openingBalanceDraftAmount('125.')).toBe(125)
    expect(openingBalanceDraftAmount('125.50')).toBe(125.5)
  })

  it('reads a leading zero on the way to an öre amount', () => {
    expect(openingBalanceDraftAmount('0')).toBe(0)
    expect(openingBalanceDraftAmount('0,')).toBe(0)
    expect(openingBalanceDraftAmount('0,5')).toBe(0.5)
    expect(openingBalanceDraftAmount(',5')).toBe(0.5)
  })

  it('reads a cleared field as 0', () => {
    expect(openingBalanceDraftAmount('')).toBe(0)
    expect(openingBalanceDraftAmount('   ')).toBe(0)
  })

  it('reads pasted, space-grouped amounts', () => {
    expect(openingBalanceDraftAmount('12 345,67')).toBe(12345.67)
    expect(openingBalanceDraftAmount('12 345,67')).toBe(12345.67)
    expect(openingBalanceDraftAmount('1.234,56')).toBe(1234.56)
  })

  it('rounds to the öre, exact halves up', () => {
    expect(openingBalanceDraftAmount('1,005')).toBe(1.01)
    expect(openingBalanceDraftAmount('10,075')).toBe(10.08)
  })

  it('commits 0 for text that is not one positive amount', () => {
    expect(openingBalanceDraftAmount(',')).toBe(0)
    expect(openingBalanceDraftAmount('abc')).toBe(0)
    expect(openingBalanceDraftAmount('12,3,4')).toBe(0)
    expect(openingBalanceDraftAmount('-50')).toBe(0)
  })
})

describe('openingBalanceAmountText', () => {
  it('shows a blank field for 0', () => {
    expect(openingBalanceAmountText(0)).toBe('')
  })

  it('shows two decimals with a comma, no grouping', () => {
    expect(openingBalanceAmountText(125)).toBe('125,00')
    expect(openingBalanceAmountText(12345.6)).toBe('12345,60')
  })

  it('round-trips through the parser', () => {
    for (const amount of [0.5, 125.5, 12345.67, 1000000]) {
      expect(openingBalanceDraftAmount(openingBalanceAmountText(amount))).toBe(amount)
    }
  })
})
