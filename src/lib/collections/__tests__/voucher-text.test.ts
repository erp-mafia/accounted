import { describe, expect, it } from 'vitest'
import { accountWithName } from '../voucher-text'

const chart = [
  { account_number: '1930', account_name: 'Företagskonto' },
  { account_number: '1689', account_name: 'Övriga kortfristiga fordringar' },
  { account_number: '2641', account_name: null },
]

describe('accountWithName', () => {
  it('names the account from the company chart', () => {
    expect(accountWithName('1930', chart)).toBe('1930 Företagskonto')
    expect(accountWithName('1689', chart)).toBe('1689 Övriga kortfristiga fordringar')
  })

  it('falls back to the BAS name for an account the chart does not hold', () => {
    expect(accountWithName('6062', chart, 'Inkasso och KFM-avgifter')).toBe('6062 Inkasso och KFM-avgifter')
    expect(accountWithName('1930', chart, 'Checkräkningskonto')).toBe('1930 Företagskonto')
  })

  it('shows the number alone when the chart does not name it or is not loaded', () => {
    expect(accountWithName('2641', chart)).toBe('2641')
    expect(accountWithName('6062', chart)).toBe('6062')
    expect(accountWithName('1930', [])).toBe('1930')
  })
})
