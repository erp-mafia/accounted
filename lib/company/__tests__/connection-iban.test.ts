import { describe, expect, it } from 'vitest'
import { formatIbanGroups, uniqueConnectionIban } from '../connection-iban'

const IBAN_A = 'SE3550000000054910000003'
const IBAN_B = 'SE4550000000058398257466'

describe('uniqueConnectionIban', () => {
  it('returns null for non-array input', () => {
    expect(uniqueConnectionIban(null)).toBeNull()
    expect(uniqueConnectionIban(undefined)).toBeNull()
    expect(uniqueConnectionIban('rows')).toBeNull()
    expect(uniqueConnectionIban({ iban: IBAN_A })).toBeNull()
  })

  it('returns null for an empty result', () => {
    expect(uniqueConnectionIban([])).toBeNull()
  })

  it('returns the IBAN when exactly one account carries one', () => {
    expect(uniqueConnectionIban([{ iban: IBAN_A }])).toBe(IBAN_A)
  })

  it('normalises spacing and case', () => {
    expect(uniqueConnectionIban([{ iban: 'se35 5000 0000 0549 1000 0003' }])).toBe(IBAN_A)
  })

  it('treats the same IBAN across several accounts as one', () => {
    expect(
      uniqueConnectionIban([
        { iban: IBAN_A },
        { iban: 'SE35 5000 0000 0549 1000 0003' },
      ]),
    ).toBe(IBAN_A)
  })

  it('returns null when accounts disagree: no guessing between banks', () => {
    expect(uniqueConnectionIban([{ iban: IBAN_A }, { iban: IBAN_B }])).toBeNull()
  })

  it('skips rows without a usable IBAN', () => {
    expect(
      uniqueConnectionIban([
        null,
        'not-a-row',
        { iban: null },
        { iban: 42 },
        { iban: 'NOT-AN-IBAN' },
        { iban: IBAN_A },
      ]),
    ).toBe(IBAN_A)
  })

  it('returns null when only invalid IBANs exist', () => {
    expect(uniqueConnectionIban([{ iban: 'SE12' }, { iban: '' }])).toBeNull()
  })
})

describe('formatIbanGroups', () => {
  it('groups the IBAN in blocks of four', () => {
    expect(formatIbanGroups(IBAN_A)).toBe('SE35 5000 0000 0549 1000 0003')
  })

  it('leaves a trailing partial group intact', () => {
    expect(formatIbanGroups('SE355000')).toBe('SE35 5000')
    expect(formatIbanGroups('SE3550001')).toBe('SE35 5000 1')
  })
})
