import { describe, it, expect } from 'vitest'
import { hasSwedishAccountChecksumRule, validateSwedishAccountChecksum } from '@/lib/bankgiro/account-number'
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

  it('returns unknown for a clearing the document does not list rather than guessing', () => {
    for (const clearing of ['9999', '2200', '9010', '9800']) {
      expect(validateSwedishAccountChecksum(clearing, '1234567'), clearing).toBe('unknown')
    }
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

describe('hasSwedishAccountChecksumRule', () => {
  it('knows the banks in the rule table, a 5-digit Swedbank clearing included', () => {
    for (const clearing of ['1100', '3300', '3400', '3410', '5000', '6000', '7000', '8169', '8169-5', '9020', '9400', '9500']) {
      expect(hasSwedishAccountChecksumRule(clearing), clearing).toBe(true)
    }
  })

  it('has no rule for banks outside the table, or for a clearing that is too short', () => {
    // 2100-2299, 9010 and 9800 are in no range of the document.
    for (const clearing of ['2200', '9010', '9800', '12', '', null]) {
      expect(hasSwedishAccountChecksumRule(clearing), String(clearing)).toBe(false)
    }
  })

  it('tells a wrong length at a known bank from a bank without a rule (both validate as unknown)', () => {
    expect(validateSwedishAccountChecksum('5000', '12345678')).toBe('unknown')
    expect(hasSwedishAccountChecksumRule('5000')).toBe(true)
    expect(validateSwedishAccountChecksum('9010', '1234567')).toBe('unknown')
    expect(hasSwedishAccountChecksumRule('9010')).toBe(false)
  })
})

// Bankgirot, "Bankernas kontonummer / Bank Account Numbers in Swedish Banks",
// 2024-02-22: every range of its Type 1 and Type 2 tables, with its comment.
const DOCUMENT_RANGES: ReadonlyArray<{ from: string; to: string; type: 1 | 2; comment: 1 | 2 | 3 }> = [
  // Type 1
  { from: '9660', to: '9669', type: 1, comment: 2 }, // Svea Bank
  { from: '9580', to: '9589', type: 1, comment: 1 }, // Aion Bank
  { from: '9550', to: '9569', type: 1, comment: 2 }, // Avanza Bank
  { from: '9680', to: '9689', type: 1, comment: 1 }, // BlueStep Finans
  { from: '9470', to: '9479', type: 1, comment: 2 }, // BNP Paribas
  { from: '9040', to: '9049', type: 1, comment: 2 }, // Citibank
  { from: '1200', to: '1399', type: 1, comment: 1 }, // Danske Bank
  { from: '2400', to: '2499', type: 1, comment: 1 }, // Danske Bank
  { from: '9190', to: '9199', type: 1, comment: 2 }, // DNB Bank
  { from: '9260', to: '9269', type: 1, comment: 2 }, // DNB Bank
  { from: '9700', to: '9709', type: 1, comment: 2 }, // Ekobanken
  { from: '9590', to: '9599', type: 1, comment: 2 }, // Erik Penser
  { from: '9270', to: '9279', type: 1, comment: 1 }, // ICA Banken
  { from: '9170', to: '9179', type: 1, comment: 1 }, // IKANO Bank
  { from: '9670', to: '9679', type: 1, comment: 2 }, // JAK Medlemsbank
  { from: '9780', to: '9789', type: 1, comment: 2 }, // Klarna Bank
  { from: '9390', to: '9399', type: 1, comment: 2 }, // Landshypotek
  { from: '9710', to: '9719', type: 1, comment: 2 }, // Lunar Bank
  { from: '9630', to: '9639', type: 1, comment: 1 }, // Lån & Spar Bank
  { from: '3400', to: '3409', type: 1, comment: 1 }, // Länsförsäkringar Bank
  { from: '9020', to: '9029', type: 1, comment: 2 }, // Länsförsäkringar Bank
  { from: '9060', to: '9069', type: 1, comment: 1 }, // Länsförsäkringar Bank
  { from: '9230', to: '9239', type: 1, comment: 1 }, // Marginalen Bank
  { from: '9070', to: '9079', type: 1, comment: 1 }, // Multitude Bank
  { from: '9640', to: '9649', type: 1, comment: 2 }, // NOBA Bank Group
  { from: '1100', to: '1199', type: 1, comment: 1 }, // Nordea
  { from: '1400', to: '2099', type: 1, comment: 1 }, // Nordea
  { from: '3000', to: '3299', type: 1, comment: 1 }, // Nordea (3000-3399 except 3300)
  { from: '3301', to: '3399', type: 1, comment: 1 }, // Nordea
  { from: '3410', to: '3781', type: 1, comment: 1 }, // Nordea (3410-3999 except 3782)
  { from: '3783', to: '3999', type: 1, comment: 1 }, // Nordea
  { from: '4000', to: '4999', type: 1, comment: 2 }, // Nordea
  { from: '9100', to: '9109', type: 1, comment: 2 }, // Nordnet Bank
  { from: '9750', to: '9759', type: 1, comment: 2 }, // Northmill Bank
  { from: '9280', to: '9289', type: 1, comment: 1 }, // Resurs Bank
  { from: '9880', to: '9889', type: 1, comment: 2 }, // Riksgälden
  { from: '9460', to: '9469', type: 1, comment: 1 }, // Santander Consumer Bank
  { from: '9250', to: '9259', type: 1, comment: 1 }, // SBAB
  { from: '5000', to: '5999', type: 1, comment: 1 }, // SEB
  { from: '9120', to: '9124', type: 1, comment: 1 }, // SEB
  { from: '9130', to: '9149', type: 1, comment: 1 }, // SEB
  { from: '9150', to: '9169', type: 1, comment: 2 }, // Skandiabanken
  { from: '7000', to: '7999', type: 1, comment: 1 }, // Swedbank
  { from: '2300', to: '2399', type: 1, comment: 2 }, // Ålandsbanken
  // Type 2
  { from: '9180', to: '9189', type: 2, comment: 1 }, // Danske Bank
  { from: '6000', to: '6999', type: 2, comment: 2 }, // Handelsbanken
  { from: '9500', to: '9549', type: 2, comment: 3 }, // Nordea/Plusgirot
  { from: '9960', to: '9969', type: 2, comment: 3 }, // Nordea/Plusgirot
  { from: '3300', to: '3300', type: 2, comment: 1 }, // Nordea personkonto
  { from: '3782', to: '3782', type: 2, comment: 1 }, // Nordea personkonto
  { from: '9890', to: '9899', type: 2, comment: 1 }, // Riksgälden
  { from: '9570', to: '9579', type: 2, comment: 1 }, // Sparbanken Syd
  { from: '8000', to: '8999', type: 2, comment: 3 }, // Swedbank
  { from: '9300', to: '9329', type: 2, comment: 1 }, // Swedbank (f.d. Sparbanken Öresund)
  { from: '9330', to: '9349', type: 2, comment: 1 }, // Swedbank (f.d. Sparbanken Öresund)
]

/**
 * The document's 11-modul, written out independently of the code under test:
 * the last digit weighs 1, the one before 2, up to 10, then 1, 2, ... again
 * from the 11th digit from the end.
 */
function mod11Sum(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const fromRight = digits.length - 1 - i
    sum += Number(digits[i]) * ((fromRight % 10) + 1)
  }
  return sum
}

/** `payload` with the 11-modul check digit appended, or null when it would be 10 (unusable). */
function mod11Complete(payload: string): string | null {
  const check = (11 - (mod11Sum(payload + '0') % 11)) % 11
  return check === 10 ? null : payload + String(check)
}

/** A synthetic account that passes the rule of `comment` at `clearing`, built from the document's text. */
function accountByRule(clearing: string, type: 1 | 2, comment: 1 | 2 | 3): string {
  if (type === 1) {
    // Comment 1 weighs the clearing without its first digit, comment 2 the
    // whole clearing; both with the 7 account digits.
    const weighed = comment === 1 ? clearing.slice(1) : clearing
    for (let base = 123456; ; base++) {
      const completed = mod11Complete(weighed + String(base))
      if (completed) return completed.slice(weighed.length)
    }
  }
  if (comment === 2) {
    for (let base = 12345678; ; base++) {
      const completed = mod11Complete(String(base))
      if (completed) return completed
    }
  }
  // Comments 1 and 3: 10-modul over the account (10 digits for comment 1).
  return luhnValid(comment === 1 ? '123456789' : '1234567')
}

/** The same account with its last digit moved by one: fails either modulus. */
function wrongLastDigit(account: string): string {
  return account.slice(0, -1) + String((Number(account.slice(-1)) + 1) % 10)
}

describe('validateSwedishAccountChecksum follows Bankgirot 2024-02-22', () => {
  for (const range of DOCUMENT_RANGES) {
    for (const clearing of new Set([range.from, range.to])) {
      it(`${clearing}: Type ${range.type}, comment ${range.comment}`, () => {
        const account = accountByRule(clearing, range.type, range.comment)
        expect(validateSwedishAccountChecksum(clearing, account)).toBe('valid')
        expect(validateSwedishAccountChecksum(clearing, wrongLastDigit(account))).toBe('invalid')
        expect(hasSwedishAccountChecksumRule(clearing)).toBe(true)
      })
    }
  }

  it('tells comment 1 from comment 2: the first clearing digit is weighed only under comment 2', () => {
    // An account built by the other comment's rule fails at the same clearing.
    expect(validateSwedishAccountChecksum('9270', accountByRule('9270', 1, 2))).toBe('invalid') // ICA Banken, comment 1
    expect(validateSwedishAccountChecksum('9550', accountByRule('9550', 1, 1))).toBe('invalid') // Avanza Bank, comment 2
  })

  it('accepts a Handelsbanken 9-digit account by 11-modul over the 9 digits, not by 10-modul', () => {
    // 123456789: 1*9 + 2*8 + 3*7 + 4*6 + 5*5 + 6*4 + 7*3 + 8*2 + 9*1 = 165 = 11 * 15.
    expect(validateSwedishAccountChecksum('6682', '123456789')).toBe('valid')
    expect(validateSwedishAccountChecksum('6682', '123456780')).toBe('invalid')
    // A 9-digit account with a leading zero, typed with or without it.
    const leadingZero = mod11Complete('07654321')!
    expect(validateSwedishAccountChecksum('6682', leadingZero)).toBe('valid')
    expect(validateSwedishAccountChecksum('6682', leadingZero.slice(1))).toBe('valid')
  })

  it('checks the fifth digit of a 5-digit Swedbank clearing by 10-modul, and only there', () => {
    const account = luhnValid('1234567')
    expect(validateSwedishAccountChecksum('8327-9', account)).toBe('valid')
    expect(validateSwedishAccountChecksum('8327-8', account)).toBe('invalid')
    // Plusgirot shares comment 3 but has no 5-digit clearing to check.
    expect(validateSwedishAccountChecksum('9500', account)).toBe('valid')
  })
})
