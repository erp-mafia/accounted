import { describe, expect, it } from 'vitest'
import { lacksSkatteverketSaldo, sidesAgree } from '../verdict'

describe('reconciliation verdict', () => {
  it('agrees when reconciled, or when a known difference is under half an öre', () => {
    expect(sidesAgree({ is_reconciled: true, difference: 12 })).toBe(true)
    expect(sidesAgree({ is_reconciled: false, difference: 0 })).toBe(true)
    expect(sidesAgree({ is_reconciled: false, difference: 0.004 })).toBe(true)
    expect(sidesAgree({ is_reconciled: false, difference: -0.01 })).toBe(false)
  })

  // crm#1701: Math.abs(difference ?? 0) made an unknown difference read as 0.
  it('never agrees on an unknown difference', () => {
    expect(sidesAgree({ is_reconciled: false, difference: null })).toBe(false)
  })

  it('a skattekonto without a saldo from Skatteverket has nothing to compare with', () => {
    expect(lacksSkatteverketSaldo({ kind: 'skattekonto', external_balance: null })).toBe(true)
    expect(lacksSkatteverketSaldo({ kind: 'skattekonto', external_balance: 0 })).toBe(false)
    // Other kinds have their own sentences.
    expect(lacksSkatteverketSaldo({ kind: 'manual', external_balance: null })).toBe(false)
    expect(lacksSkatteverketSaldo({ kind: 'bank', external_balance: null })).toBe(false)
  })
})
