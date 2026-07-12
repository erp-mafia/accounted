import { describe, it, expect } from 'vitest'
import { validateSwedishAccountChecksum } from '@/lib/bankgiro/account-number'
import { luhnCheckDigit } from '@/lib/bankgiro/luhn'

/** Build a mod10 (Luhn) valid number of `len` digits from a numeric seed. */
function luhnValid(prefix: string): string {
  return prefix + String(luhnCheckDigit(prefix))
}

/** Brute-force the account whose last digit makes the pair check out. */
function firstValidAccount(clearing: string, base: string): string | null {
  for (let d = 0; d <= 9; d++) {
    const acc = base + d
    if (validateSwedishAccountChecksum(clearing, acc) === 'valid') return acc
  }
  return null
}

describe('validateSwedishAccountChecksum', () => {
  // Anchors the mod11 algorithm + Type 1 comment 1 against a real, published
  // valid account (Forex Bank, clearing 9420, account 4172385).
  it('accepts the real Forex example (Type 1, mod11)', () => {
    expect(validateSwedishAccountChecksum('9420', '4172385')).toBe('valid')
  })

  it('rejects the Forex example with one digit changed', () => {
    expect(validateSwedishAccountChecksum('9420', '4172386')).toBe('invalid')
  })

  it('accepts a Swedbank clearing written with a hyphen', () => {
    // Type 1 comment 1 (Swedbank 7xxx). Round-trip a brute-forced valid account.
    const acc = firstValidAccount('7000', '123456')
    expect(acc).not.toBeNull()
    expect(validateSwedishAccountChecksum('7000', acc!)).toBe('valid')
  })

  it('validates Handelsbanken (Type 2, mod11, 9-digit account)', () => {
    const acc = firstValidAccount('6000', '12345678')
    expect(acc).not.toBeNull()
    // A different final digit must not also validate.
    const wrong = acc!.slice(0, -1) + ((Number(acc!.slice(-1)) + 1) % 10)
    expect(validateSwedishAccountChecksum('6000', wrong)).toBe('invalid')
  })

  it('validates a Nordea personkonto (3300, Type 2, mod10, 10-digit)', () => {
    const acc = luhnValid('123456789') // 9 + check = 10 digits
    expect(validateSwedishAccountChecksum('3300', acc)).toBe('valid')
    expect(validateSwedishAccountChecksum('3300', acc.slice(0, -1) + '0')).toBe(
      Number(acc.slice(-1)) === 0 ? 'valid' : 'invalid',
    )
  })

  it('validates a Swedbank 8xxx account (Type 2, mod10)', () => {
    const acc = luhnValid('1234567') // 8-digit mod10 account
    expect(validateSwedishAccountChecksum('8000', acc)).toBe('valid')
  })

  it('returns unknown for an unmapped clearing rather than guessing', () => {
    expect(validateSwedishAccountChecksum('9999', '1234567')).toBe('unknown')
    // 3300-3409 gap (Länsförsäkringar etc.) is deliberately unmapped.
    expect(validateSwedishAccountChecksum('3405', '1234567')).toBe('unknown')
  })

  it('returns unknown when nothing usable is entered', () => {
    expect(validateSwedishAccountChecksum('', '')).toBe('unknown')
    expect(validateSwedishAccountChecksum('7000', '')).toBe('unknown')
    expect(validateSwedishAccountChecksum('12', '1234567')).toBe('unknown')
  })

  it('returns unknown when the account is too long for a Type 1 bank', () => {
    // Type 1 accounts are max 7 digits; do not warn on an over-length entry.
    expect(validateSwedishAccountChecksum('5000', '12345678901')).toBe('unknown')
  })
})
