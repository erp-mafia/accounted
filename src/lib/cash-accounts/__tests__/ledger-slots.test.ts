import { describe, expect, it } from 'vitest'
import { bankLedgerName, holderAdoptableBy, overflowLedgerSlots } from '../ledger-slots'

describe('overflowLedgerSlots', () => {
  it('skips the currency defaults and the taken slots', () => {
    expect(overflowLedgerSlots(['1931']).slice(0, 3)).toEqual(['1935', '1936', '1937'])
  })

  it('hands out numbers the chart does not have before the ones it names', () => {
    const slots = overflowLedgerSlots([], ['1931', '1935'])
    expect(slots.slice(0, 2)).toEqual(['1936', '1937'])
    expect(slots.slice(-2)).toEqual(['1931', '1935'])
  })

  it('is empty when every slot is taken', () => {
    const all = Array.from({ length: 29 }, (_, i) => String(1931 + i))
    expect(overflowLedgerSlots(all)).toEqual([])
  })
})

describe('bankLedgerName', () => {
  it('names a new bank account after its currency', () => {
    expect(bankLedgerName('sek')).toBe('Bankkonto SEK')
    expect(bankLedgerName('EUR')).toBe('Bankkonto EUR')
  })
})

describe('holderAdoptableBy', () => {
  // The rule promote_psd2_cash_account applies before it takes over a row.
  const IBAN = 'SE4550000000058398257466'
  const want = { iban: IBAN, currency: 'SEK' }

  it('takes over an unclaimed row of the same account, or one without an IBAN', () => {
    expect(holderAdoptableBy({ iban: 'se45 5000 0000 0583 9825 7466', currency: 'SEK', live: false }, want)).toBe(true)
    expect(holderAdoptableBy({ iban: null, currency: 'SEK', live: false }, want)).toBe(true)
    expect(holderAdoptableBy({ iban: null, currency: 'SEK', live: false }, { iban: null, currency: 'sek' })).toBe(true)
  })

  it('never takes over another IBAN, another currency or a live claim', () => {
    expect(holderAdoptableBy({ iban: 'SE9912000000000000000001', currency: 'SEK', live: false }, want)).toBe(false)
    expect(holderAdoptableBy({ iban: IBAN, currency: 'EUR', live: false }, want)).toBe(false)
    expect(holderAdoptableBy({ iban: IBAN, currency: 'SEK', live: true }, want)).toBe(false)
  })

  it('an account without an IBAN cannot take over a row that has one', () => {
    expect(holderAdoptableBy({ iban: IBAN, currency: 'SEK', live: false }, { iban: null, currency: 'SEK' })).toBe(false)
    expect(holderAdoptableBy({ iban: IBAN, currency: 'SEK', live: false }, { currency: 'SEK' })).toBe(false)
  })
})
