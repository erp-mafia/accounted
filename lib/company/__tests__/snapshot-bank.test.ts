import { describe, it, expect } from 'vitest'
import { bankgiroFromTicSnapshot } from '../snapshot-bank'

// 5402-9681 is a Luhn-valid synthetic bankgiro; 5402-9682 fails the check.
const VALID_BG = '54029681'
const INVALID_BG = '54029682'

describe('bankgiroFromTicSnapshot', () => {
  it('returns null for null, undefined and non-object snapshots', () => {
    expect(bankgiroFromTicSnapshot(null)).toBeNull()
    expect(bankgiroFromTicSnapshot(undefined)).toBeNull()
    expect(bankgiroFromTicSnapshot('a string')).toBeNull()
  })

  it('returns null when bankAccounts is missing or not an array', () => {
    expect(bankgiroFromTicSnapshot({})).toBeNull()
    expect(bankgiroFromTicSnapshot({ bankAccounts: 'nope' })).toBeNull()
    expect(bankgiroFromTicSnapshot({ bankAccounts: null })).toBeNull()
  })

  it('returns null when only non-bankgiro accounts exist', () => {
    expect(
      bankgiroFromTicSnapshot({
        bankAccounts: [{ type: 'plusgiro', accountNumber: '1234567' }],
      }),
    ).toBeNull()
  })

  it('returns the digits of a valid bankgiro account', () => {
    expect(
      bankgiroFromTicSnapshot({
        bankAccounts: [{ type: 'bankgiro', accountNumber: VALID_BG }],
      }),
    ).toBe(VALID_BG)
  })

  it('strips hyphens and spaces from the registry value', () => {
    expect(
      bankgiroFromTicSnapshot({
        bankAccounts: [{ type: 'bankgiro', accountNumber: '5402-9681' }],
      }),
    ).toBe(VALID_BG)
  })

  it('skips bankgiro entries that fail the Luhn check', () => {
    expect(
      bankgiroFromTicSnapshot({
        bankAccounts: [{ type: 'bankgiro', accountNumber: INVALID_BG }],
      }),
    ).toBeNull()
  })

  it('skips malformed entries and finds a later valid one', () => {
    expect(
      bankgiroFromTicSnapshot({
        bankAccounts: [
          null,
          { type: 'bankgiro' },
          { type: 'bankgiro', accountNumber: 12345 },
          { type: 'bankgiro', accountNumber: VALID_BG },
        ],
      }),
    ).toBe(VALID_BG)
  })
})
