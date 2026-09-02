import { describe, expect, it } from 'vitest'
import { classifyKey } from '../classify'

// Founder-labelled examples from the 2026-09-02 golden set, one per rule.
describe('classifyKey', () => {
  it.each([
    ['levfakt beijer byggmaterial 097', '4000', 'party'],
    ['leverantörsfaktura från 157 råå bryggeri', '4010', 'party'],
    ['loopia', '6542', 'party'],
    ['taxi stockholm', '5800', 'party'],
    ['inköp av varor', '4010', 'category'],
    ['bankkostnad', '6570', 'bank'],
    ['baspaket bank', '6570', 'bank'],
    ['fika', '7690', 'category'],
    ['löneutbetalning anställd 15', '7210', 'payroll'],
    ['transaktion betalning mot rapport', '7200', 'payroll'],
    ['periodisering av verifikation d19', '5010', 'adjustment'],
    ['lagerförändring', '4000', 'adjustment'],
    ['bolagsverket ändra bolagsordning', '6991', 'authority'],
    ['skattekonto', '6992', 'authority'],
    ['klarna', '6570', 'intermediary'],
    ['diesel', '5611', 'category'],
    ['telefon', '6210', 'category'],
  ] as const)('%s (%s) -> %s', (key, acct, expected) => {
    expect(classifyKey({ key, acct })).toBe(expected)
  })

  it('treats a card-platform line with a person suffix as a party', () => {
    expect(classifyKey({ key: 'pleo andreas', acct: '4535' })).toBe('party')
  })

  it('does not let BAS description examples make Google look generic', () => {
    expect(classifyKey({ key: 'cc google co', acct: '5420' })).toBe('party')
  })

  it('returns unsure for an empty or all-noise key', () => {
    expect(classifyKey({ key: '' })).toBe('unsure')
    expect(classifyKey({ key: '12 34' })).toBe('unsure')
  })
})
