import { describe, it, expect } from 'vitest'
import { BAS_ACCOUNT_NUMBERS, isStandardBASAccountNumber } from '../bas-account-numbers'
import { BAS_REFERENCE } from '../bas-data'
import { isStandardBASAccount } from '../bas-reference'

describe('bas-account-numbers (generated)', () => {
  it('matches the BAS chart exactly, so the light module never drifts from the data', () => {
    const fromChart = [...new Set(BAS_REFERENCE.map((a) => a.account_number))].sort()
    expect([...BAS_ACCOUNT_NUMBERS]).toEqual(fromChart)
  })

  it('answers isStandardBASAccount identically', () => {
    for (const n of ['1930', '2440', '3001', '6110', '9999', '0000', '19300']) {
      expect(isStandardBASAccountNumber(n)).toBe(isStandardBASAccount(n))
    }
  })
})
