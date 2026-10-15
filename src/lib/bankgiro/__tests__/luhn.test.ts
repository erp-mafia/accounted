import {
  luhnCheckDigit,
  luhnValidate,
  validateBankgiroNumber,
  formatBankgiroNumber,
  validatePlusgiroNumber,
  formatPlusgiroNumber,
  generateOcrReference,
  generateLengthDigitOcrReference,
  validateOcrReference,
} from '../luhn'

// -- Luhn core --

describe('luhnCheckDigit', () => {
  it('calculates check digit for Bankgiro 991-2346', () => {
    expect(luhnCheckDigit('991234')).toBe(6)
  })

  it('calculates check digit for Bankgiro 5555-5551', () => {
    expect(luhnCheckDigit('5555555')).toBe(1)
  })

  it('returns 0 when sum is already a multiple of 10', () => {
    // 0: weight 2, product 0. Sum=0 → check=0
    expect(luhnCheckDigit('0')).toBe(0)
  })
})

describe('luhnValidate', () => {
  it('validates correct numbers', () => {
    expect(luhnValidate('9912346')).toBe(true)
    expect(luhnValidate('55555551')).toBe(true)
  })

  it('rejects incorrect check digits', () => {
    expect(luhnValidate('9912345')).toBe(false)
    expect(luhnValidate('55555552')).toBe(false)
  })

  it('rejects single-digit input', () => {
    expect(luhnValidate('5')).toBe(false)
  })
})

// -- Bankgiro --

describe('validateBankgiroNumber', () => {
  it('validates 7-digit bankgiro with hyphen', () => {
    expect(validateBankgiroNumber('991-2346')).toBe(true)
  })

  it('validates 8-digit bankgiro with hyphen', () => {
    expect(validateBankgiroNumber('5555-5551')).toBe(true)
  })

  it('validates raw digits without hyphen', () => {
    expect(validateBankgiroNumber('9912346')).toBe(true)
    expect(validateBankgiroNumber('55555551')).toBe(true)
  })

  it('rejects wrong check digit', () => {
    expect(validateBankgiroNumber('991-2345')).toBe(false)
  })

  it('rejects wrong length', () => {
    expect(validateBankgiroNumber('12345')).toBe(false)
    expect(validateBankgiroNumber('123456789')).toBe(false)
  })

  it('rejects non-numeric input', () => {
    expect(validateBankgiroNumber('abc-defg')).toBe(false)
  })

  it('handles spaces', () => {
    expect(validateBankgiroNumber('991 2346')).toBe(true)
  })
})

describe('formatBankgiroNumber', () => {
  it('formats 7-digit as XXX-XXXX', () => {
    expect(formatBankgiroNumber('9912346')).toBe('991-2346')
  })

  it('formats 8-digit as XXXX-XXXX', () => {
    expect(formatBankgiroNumber('55555551')).toBe('5555-5551')
  })

  it('handles already-formatted input', () => {
    expect(formatBankgiroNumber('991-2346')).toBe('991-2346')
  })

  it('returns input unchanged for invalid lengths', () => {
    expect(formatBankgiroNumber('12345')).toBe('12345')
  })
})

// -- Plusgiro --

describe('validatePlusgiroNumber', () => {
  it('validates plusgiro with hyphen', () => {
    // 4567 → Luhn check digit 4 → "4567-4"
    expect(validatePlusgiroNumber('4567-4')).toBe(true)
  })

  it('validates raw digits without hyphen', () => {
    expect(validatePlusgiroNumber('45674')).toBe(true)
    expect(validatePlusgiroNumber('1234566')).toBe(true)
  })

  it('validates short (2-digit) plusgiro', () => {
    // "0" → check digit 0 → "00"
    expect(validatePlusgiroNumber('00')).toBe(true)
  })

  it('validates full 8-digit plusgiro', () => {
    expect(validatePlusgiroNumber('55555551')).toBe(true)
  })

  it('rejects wrong check digit', () => {
    expect(validatePlusgiroNumber('4567-5')).toBe(false)
  })

  it('rejects too long (>8 digits)', () => {
    expect(validatePlusgiroNumber('123456789')).toBe(false)
  })

  it('rejects single-digit input', () => {
    expect(validatePlusgiroNumber('5')).toBe(false)
  })

  it('rejects non-numeric input', () => {
    expect(validatePlusgiroNumber('abc-d')).toBe(false)
  })

  it('handles spaces', () => {
    expect(validatePlusgiroNumber('4567 4')).toBe(true)
  })
})

describe('formatPlusgiroNumber', () => {
  it('places hyphen before the check digit', () => {
    expect(formatPlusgiroNumber('45674')).toBe('4567-4')
  })

  it('formats 8-digit as XXXXXXX-X', () => {
    expect(formatPlusgiroNumber('55555551')).toBe('5555555-1')
  })

  it('handles already-formatted input', () => {
    expect(formatPlusgiroNumber('4567-4')).toBe('4567-4')
  })

  it('returns input unchanged for invalid lengths', () => {
    expect(formatPlusgiroNumber('5')).toBe('5')
    expect(formatPlusgiroNumber('123456789')).toBe('123456789')
  })
})

// -- OCR reference --

describe('generateOcrReference', () => {
  it('appends correct check digit to numeric invoice number', () => {
    const ocr = generateOcrReference('12345')
    // 12345 → check digit 5 → '123455'
    expect(ocr).toBe('123455')
    expect(validateOcrReference(ocr)).toBe(true)
  })

  it('strips non-numeric characters from invoice number', () => {
    const ocr = generateOcrReference('INV-2024-001')
    // digits: 2024001
    expect(ocr).toBe(generateOcrReference('2024001'))
    expect(validateOcrReference(ocr)).toBe(true)
  })

  it('handles pure-numeric invoice numbers', () => {
    const ocr = generateOcrReference('20240001')
    expect(validateOcrReference(ocr)).toBe(true)
    expect(ocr.length).toBe(9)
  })

  it('returns original if no digits found', () => {
    expect(generateOcrReference('ABC')).toBe('ABC')
  })

  it('returns original if digits exceed 24 characters', () => {
    const long = '1'.repeat(25)
    expect(generateOcrReference(long)).toBe(long)
  })

  it('generates valid OCR for single-digit invoice number', () => {
    const ocr = generateOcrReference('7')
    expect(ocr.length).toBe(2)
    expect(validateOcrReference(ocr)).toBe(true)
  })
})

describe('validateOcrReference', () => {
  it('validates correct OCR', () => {
    expect(validateOcrReference('123455')).toBe(true)
  })

  it('rejects non-numeric', () => {
    expect(validateOcrReference('12345a')).toBe(false)
  })

  it('rejects too short', () => {
    expect(validateOcrReference('5')).toBe(false)
  })

  it('rejects too long (>25 digits)', () => {
    expect(validateOcrReference('1'.repeat(26))).toBe(false)
  })

  it('rejects incorrect check digit', () => {
    expect(validateOcrReference('123459')).toBe(false)
  })
})

// Bankgirot, "Bankgiro Inbetalningar Användarmanual" (oktober 2023), 5.2.1-5.2.3.
describe('generateLengthDigitOcrReference', () => {
  it('puts the whole length before the check digit: invoice 316 is paid as 31658', () => {
    expect(generateLengthDigitOcrReference('316')).toBe('31658')
  })

  it("reproduces the manual's worked reference 12345682 (length digit 8, check digit 2)", () => {
    expect(generateLengthDigitOcrReference('123456')).toBe('12345682')
    expect(validateOcrReference('12345682')).toBe(true)
  })

  it('writes only the last digit of a length of ten or more, as the length table does', () => {
    // 8 digits + length digit + check digit = 10 positions: length digit 0.
    const ocr = generateLengthDigitOcrReference('2026-0042')!
    expect(ocr).toHaveLength(10)
    expect(ocr.slice(0, 9)).toBe('202600420')
    expect(validateOcrReference(ocr)).toBe(true)
    // 23 digits reach the 25-position maximum: length digit 5.
    const longest = generateLengthDigitOcrReference('1'.repeat(23))!
    expect(longest).toHaveLength(25)
    expect(longest[23]).toBe('5')
    expect(validateOcrReference(longest)).toBe(true)
  })

  it('declines a number without digits or longer than a reference part may be', () => {
    expect(generateLengthDigitOcrReference('ABC')).toBeNull()
    expect(generateLengthDigitOcrReference('1'.repeat(24))).toBeNull()
  })
})
