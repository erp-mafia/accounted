import { describe, it, expect } from 'vitest'
import { isAccountNumber, accountClass, ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { isIsoDateShaped, isSaneDateString, ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { isFiscalYear, FISCAL_YEAR_RE } from '@/lib/invariants/fiscal-year'
import { isSaneDateString as isSaneDateStringFromUtils } from '@/lib/utils'

describe('account number', () => {
  it('accepts exactly four digits, as a string', () => {
    expect(isAccountNumber('1930')).toBe(true)
    expect(isAccountNumber('0000')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isAccountNumber('193')).toBe(false)
    expect(isAccountNumber('19300')).toBe(false)
    expect(isAccountNumber('19a0')).toBe(false)
    expect(isAccountNumber(' 1930')).toBe(false)
    expect(isAccountNumber('')).toBe(false)
    expect(isAccountNumber(null)).toBe(false)
    expect(isAccountNumber(undefined)).toBe(false)
  })

  it('reads the BAS account class off the leading digit', () => {
    expect(accountClass('1930')).toBe(1)
    expect(accountClass('2440')).toBe(2)
    expect(accountClass('3001')).toBe(3)
    expect(accountClass('8910')).toBe(8)
    expect(accountClass('nope')).toBeNull()
  })
})

describe('iso date', () => {
  it('shape check accepts the right shape, including impossible dates', () => {
    expect(isIsoDateShaped('2026-01-31')).toBe(true)
    // Shape only: this is the documented difference from isSaneDateString.
    expect(isIsoDateShaped('2026-02-31')).toBe(true)
    expect(isIsoDateShaped('2026-1-31')).toBe(false)
    expect(isIsoDateShaped('31/01/2026')).toBe(false)
    expect(isIsoDateShaped(null)).toBe(false)
  })

  it('sane check rejects impossible and out-of-range dates', () => {
    expect(isSaneDateString('2026-01-31')).toBe(true)
    expect(isSaneDateString('2026-02-31')).toBe(false)
    expect(isSaneDateString('2024-13-40')).toBe(false)
    // The native <input type="date"> 6-digit-year corruption.
    expect(isSaneDateString('202403-02-05')).toBe(false)
    expect(isSaneDateString('1899-12-31')).toBe(false)
    expect(isSaneDateString('2101-01-01')).toBe(false)
  })

  it('is the same function utils re-exports, not a second copy', () => {
    expect(isSaneDateStringFromUtils).toBe(isSaneDateString)
  })
})

describe('fiscal year', () => {
  it('accepts a four-digit year in range', () => {
    expect(isFiscalYear('2026')).toBe(true)
    expect(isFiscalYear(2026)).toBe(true)
    expect(isFiscalYear('1900')).toBe(true)
  })

  it('rejects out-of-range and wrong shapes', () => {
    expect(isFiscalYear('1899')).toBe(false)
    expect(isFiscalYear('2201')).toBe(false)
    expect(isFiscalYear('26')).toBe(false)
    expect(isFiscalYear('')).toBe(false)
    expect(isFiscalYear(null)).toBe(false)
  })
})

describe('the deliberate regex collision', () => {
  /**
   * `account-number` and `fiscal-year` share a byte-identical regex and mean
   * entirely different things. This test exists so that anyone tempted to
   * "deduplicate" them has to read why they are separate first.
   */
  it('account number and fiscal year share a pattern but not a rule', () => {
    expect(ACCOUNT_NUMBER_RE.source).toBe(FISCAL_YEAR_RE.source)

    // '1930' is a real bank account and an absurd fiscal year in our range,
    // '2026' is a real fiscal year and a valid BAS account number. Only the
    // named rules can tell a caller which one it is holding.
    expect(isAccountNumber('1930')).toBe(true)
    expect(isFiscalYear('1930')).toBe(true)
    expect(isFiscalYear('0000')).toBe(false)
    expect(isAccountNumber('0000')).toBe(true)
  })

  it('the iso-date pattern is not the four-digit pattern', () => {
    expect(ISO_DATE_RE.source).not.toBe(ACCOUNT_NUMBER_RE.source)
  })
})
