import { describe, expect, it } from 'vitest'
import { assetBalance, liabilityBalance, summarizeLines } from '../findings'

describe('summarizeLines', () => {
  it('reads revenue as class-3 credit and result across classes 3 to 8', () => {
    const s = summarizeLines([
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
      { account_number: '5010', debit_amount: 400, credit_amount: 0 },
      { account_number: '8910', debit_amount: 100, credit_amount: 0 },
    ])
    expect(s.revenue).toBe(1000)
    expect(s.result).toBe(500)
  })

  it('accepts numeric strings from PostgREST and rounds to öre', () => {
    const s = summarizeLines([
      { account_number: '3001', debit_amount: '0', credit_amount: '10.005' },
      { account_number: '3002', debit_amount: '0.001', credit_amount: '0' },
    ])
    expect(s.revenue).toBe(10)
  })
})

describe('balances', () => {
  it('1630 is an asset: debit minus credit', () => {
    expect(assetBalance([
      { account_number: '1630', debit_amount: 5000, credit_amount: 1200 },
    ])).toBe(3800)
  })

  it('26xx is a liability: credit minus debit, positive = owed to Skatteverket', () => {
    expect(liabilityBalance([
      { account_number: '2611', debit_amount: 0, credit_amount: 2500 },
      { account_number: '2641', debit_amount: 900, credit_amount: 0 },
    ])).toBe(1600)
  })
})
