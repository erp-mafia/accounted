import { describe, it, expect } from 'vitest'
import { mappingRuleAccount } from '../bank-leg'

describe('mappingRuleAccount', () => {
  it('reads the debit of a rule learned on money out', () => {
    expect(mappingRuleAccount({ debit_account: '6212', credit_account: '1930' })).toBe('6212')
    expect(mappingRuleAccount({ debit_account: '6212', credit_account: '2890' })).toBe('6212')
  })

  it('reads the credit of a rule learned on money in, whose debit is the bank', () => {
    expect(mappingRuleAccount({ debit_account: '1930', credit_account: '3001' })).toBe('3001')
    expect(mappingRuleAccount({ debit_account: '1930', credit_account: '1686' })).toBe('1686')
  })

  it('reads a rule between two own 19xx ledgers, or with one leg missing, as its debit', () => {
    expect(mappingRuleAccount({ debit_account: '1940', credit_account: '1930' })).toBe('1940')
    expect(mappingRuleAccount({ debit_account: '1930', credit_account: null })).toBe('1930')
    expect(mappingRuleAccount({ debit_account: null, credit_account: '3001' })).toBe(null)
  })
})
