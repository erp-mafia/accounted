import { describe, expect, it } from 'vitest'
import {
  bankLedgerName,
  holderAdoptableBy,
  overflowLedgerSlots,
  paymentDetailsPointAt,
  seededRowBelongsToAnother,
} from '../ledger-slots'

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

// Two accounts of one SEB consent (fictitious numbers): an empty second
// account listed first, then the company's own account.
const SECOND = { iban: 'SE0150000000055011112222', bban: '55011112222', currency: 'SEK' }
const OWN = { iban: 'SE0250000000055013334444', bban: '55013334444', currency: 'SEK' }

describe('paymentDetailsPointAt', () => {
  it('finds the account from clearing plus account number', () => {
    expect(paymentDetailsPointAt({ clearing_number: '5501', account_number: '3334444' }, OWN)).toBe(true)
    expect(paymentDetailsPointAt({ clearing_number: '5501', account_number: '3334444' }, SECOND)).toBe(false)
  })

  it('takes the clearing number out of the account field once, and tolerates a digit or two missing', () => {
    expect(paymentDetailsPointAt({ clearing_number: '5501', account_number: '5501 33344' }, OWN)).toBe(true)
    expect(paymentDetailsPointAt({ clearing_number: '5501', account_number: '5501 33344' }, SECOND)).toBe(false)
  })

  it('matches the account number alone when the IBAN carries no clearing number', () => {
    const handelsbanken = { iban: 'SE0360000000000123456789', currency: 'SEK' }
    expect(paymentDetailsPointAt({ clearing_number: '6123', account_number: '123 456 789' }, handelsbanken)).toBe(true)
  })

  it('ignores details too short to tell accounts apart', () => {
    expect(paymentDetailsPointAt({ clearing_number: null, account_number: '4444' }, OWN)).toBe(false)
    expect(paymentDetailsPointAt({ clearing_number: '5501', account_number: null }, OWN)).toBe(false)
    expect(paymentDetailsPointAt({}, OWN)).toBe(false)
  })
})

describe('seededRowBelongsToAnother', () => {
  const seeded = { iban: null, currency: 'SEK', clearing_number: '5501', account_number: '3334444' }

  it('leaves the seeded row to the account its details name (crm#1498)', () => {
    expect(seededRowBelongsToAnother(seeded, SECOND, [SECOND, OWN])).toBe(true)
    expect(seededRowBelongsToAnother(seeded, OWN, [SECOND, OWN])).toBe(false)
  })

  it('matches the asking account by BBAN when the bank gives no IBAN', () => {
    const own = { bban: OWN.bban, currency: 'SEK' }
    expect(seededRowBelongsToAnother(seeded, own, [{ bban: SECOND.bban, currency: 'SEK' }, own])).toBe(false)
  })

  it('keeps the first-come rule when no account, or more than one, matches', () => {
    const none = { ...seeded, account_number: '9999999' }
    expect(seededRowBelongsToAnother(none, SECOND, [SECOND, OWN])).toBe(false)
    const twin = { iban: 'SE0450000000099013334444', currency: 'SEK' }
    expect(seededRowBelongsToAnother(seeded, SECOND, [SECOND, OWN, twin])).toBe(false)
    expect(seededRowBelongsToAnother({ iban: null, currency: 'SEK' }, SECOND, [SECOND, OWN])).toBe(false)
  })

  it('only counts accounts in the seeded row\'s currency', () => {
    expect(seededRowBelongsToAnother(seeded, SECOND, [SECOND, { ...OWN, currency: 'EUR' }])).toBe(false)
  })

  it('leaves the seeded row to the account its printed IBAN names when it has no clearing or account number', () => {
    const printed = { iban: null, currency: 'SEK', clearing_number: null, account_number: null, payee_iban: 'se02 5000 0000 0550 1333 4444' }
    expect(seededRowBelongsToAnother(printed, SECOND, [SECOND, OWN])).toBe(true)
    expect(seededRowBelongsToAnother(printed, OWN, [SECOND, OWN])).toBe(false)
  })

  it('keeps the first-come rule when the printed IBAN names no account of the consent', () => {
    const elsewhere = { iban: null, currency: 'SEK', payee_iban: 'SE9912000000000000000001' }
    expect(seededRowBelongsToAnother(elsewhere, SECOND, [SECOND, OWN])).toBe(false)
  })

  it('keeps the first-come rule when the printed IBAN and the account number name different accounts', () => {
    expect(seededRowBelongsToAnother({ ...seeded, payee_iban: SECOND.iban }, SECOND, [SECOND, OWN])).toBe(false)
  })

  it('never applies to a row with an IBAN of its own (the IBAN rule decides)', () => {
    expect(seededRowBelongsToAnother({ ...seeded, iban: OWN.iban }, SECOND, [SECOND, OWN])).toBe(false)
  })
})
