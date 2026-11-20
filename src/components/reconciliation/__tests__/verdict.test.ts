import { describe, expect, it } from 'vitest'
import { lacksSkatteverketSaldo, sidesAgree, skatteverketNotConnected } from '../verdict'

function skvBlock(reason: 'not_connected' | 'not_fetched' | null) {
  return {
    saldo_skatteverket: null,
    saldo_missing_reason: reason,
    fetched_at: null,
    history_start: null,
    opening_difference: null,
    upcoming_count: 0,
    upcoming_total: 0,
    ledger_balance_before_start: null,
  }
}

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

  // crm#1701: a company that disconnected did fetch a saldo once, so the page
  // says it is not connected rather than "never fetched".
  it('names a missing connection as the reason, only on the skattekonto', () => {
    expect(skatteverketNotConnected({ kind: 'skattekonto', skattekonto: skvBlock('not_connected') })).toBe(true)
    expect(skatteverketNotConnected({ kind: 'skattekonto', skattekonto: skvBlock('not_fetched') })).toBe(false)
    expect(skatteverketNotConnected({ kind: 'skattekonto', skattekonto: skvBlock(null) })).toBe(false)
    expect(skatteverketNotConnected({ kind: 'skattekonto', skattekonto: null })).toBe(false)
    expect(skatteverketNotConnected({ kind: 'bank', skattekonto: skvBlock('not_connected') })).toBe(false)
  })
})
