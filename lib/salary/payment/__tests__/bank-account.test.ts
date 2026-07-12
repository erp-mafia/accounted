import { describe, it, expect } from 'vitest'
import {
  normalizeBankNumber,
  isValidClearing,
  isValidAccount,
  validateEmployeeBankAccount,
  lookupBankByClearing,
  lookupBicByClearing,
  lookupBicByBankName,
  splitDomesticBankAccount,
} from '@/lib/salary/payment/bank-account'

describe('splitDomesticBankAccount', () => {
  it('passes a 4-digit clearing + account through unchanged', () => {
    expect(splitDomesticBankAccount('6000', '1234567')).toEqual({
      clearing4: '6000',
      accountDigits: '1234567',
    })
  })

  it('moves the 5th digit of a Swedbank clearing into the account field', () => {
    expect(splitDomesticBankAccount('83279', '1234567890')).toEqual({
      clearing4: '8327',
      accountDigits: '91234567890',
    })
  })

  it('strips the redundant clearing prefix from an 11-digit Nordea personkonto', () => {
    expect(splitDomesticBankAccount('1708', '17082042825')).toEqual({
      clearing4: '1708',
      accountDigits: '2042825',
    })
  })

  it('keeps an 11-digit account that does not start with the clearing', () => {
    expect(splitDomesticBankAccount('3300', '19850101234')).toEqual({
      clearing4: '3300',
      accountDigits: '19850101234',
    })
  })

  it('normalizes hyphens and spaces before splitting', () => {
    expect(splitDomesticBankAccount('8327-9', '123 456 789 0')).toEqual({
      clearing4: '8327',
      accountDigits: '91234567890',
    })
  })

  it('throws on an invalid clearing number', () => {
    expect(() => splitDomesticBankAccount('123', '1234567')).toThrow('Ogiltigt clearingnummer')
    expect(() => splitDomesticBankAccount('12345', '1234567')).toThrow('Ogiltigt clearingnummer')
  })
})

describe('normalizeBankNumber', () => {
  it('strips spaces and hyphens', () => {
    expect(normalizeBankNumber('8327-9')).toBe('83279')
    expect(normalizeBankNumber('1234 5678')).toBe('12345678')
  })
  it('handles null/undefined', () => {
    expect(normalizeBankNumber(null)).toBe('')
    expect(normalizeBankNumber(undefined)).toBe('')
  })
})

describe('isValidClearing', () => {
  it('accepts 4-digit clearings', () => {
    expect(isValidClearing('1234')).toBe(true)
    expect(isValidClearing('6000')).toBe(true)
  })
  it('accepts 5-digit Swedbank clearings starting with 8', () => {
    expect(isValidClearing('83279')).toBe(true)
  })
  it('rejects 5-digit clearings not starting with 8', () => {
    expect(isValidClearing('12345')).toBe(false)
  })
  it('rejects too short / non-numeric', () => {
    expect(isValidClearing('123')).toBe(false)
    expect(isValidClearing('abcd')).toBe(false)
  })
})

describe('isValidAccount', () => {
  it('accepts 5-11 digit accounts', () => {
    expect(isValidAccount('12345')).toBe(true)
    expect(isValidAccount('1234567')).toBe(true)
    expect(isValidAccount('17082042825')).toBe(true) // 11-digit Nordea personkonto
  })
  it('rejects too short / too long / non-numeric', () => {
    expect(isValidAccount('1234')).toBe(false)
    expect(isValidAccount('123456789012')).toBe(false)
    expect(isValidAccount('12a4567')).toBe(false)
  })
})

describe('validateEmployeeBankAccount', () => {
  it('allows both empty (bank details optional until a salary run)', () => {
    expect(validateEmployeeBankAccount('', '')).toEqual([])
    expect(validateEmployeeBankAccount(null, undefined)).toEqual([])
  })

  it('accepts a valid 4-digit clearing + account pair', () => {
    expect(validateEmployeeBankAccount('6000', '1234567')).toEqual([])
  })

  it('accepts a Swedbank clearing written with a hyphen', () => {
    expect(validateEmployeeBankAccount('8327-9', '1234567')).toEqual([])
  })

  it('flags a lone clearing as needing an account', () => {
    const issues = validateEmployeeBankAccount('6000', '')
    expect(issues.map((i) => i.code)).toContain('account_required')
    expect(issues[0].field).toBe('bank_account_number')
  })

  it('flags a lone account as needing a clearing', () => {
    const issues = validateEmployeeBankAccount('', '1234567')
    expect(issues.map((i) => i.code)).toContain('clearing_required')
  })

  it('flags a malformed clearing', () => {
    const issues = validateEmployeeBankAccount('12', '1234567')
    expect(issues.map((i) => i.code)).toContain('clearing_format')
  })

  it('flags a malformed account', () => {
    const issues = validateEmployeeBankAccount('6000', '12')
    expect(issues.map((i) => i.code)).toContain('account_format')
  })
})

describe('lookupBankByClearing', () => {
  it('maps the major, unambiguous ranges', () => {
    expect(lookupBankByClearing('5000')).toBe('SEB')
    expect(lookupBankByClearing('6789')).toBe('Handelsbanken')
    expect(lookupBankByClearing('7123')).toBe('Swedbank')
    expect(lookupBankByClearing('3000')).toBe('Nordea')
  })
  it('maps a 5-digit Swedbank clearing via its 8xxx prefix', () => {
    expect(lookupBankByClearing('83279')).toBe('Swedbank/Sparbanken')
  })
  it('returns null for unknown ranges rather than guessing', () => {
    expect(lookupBankByClearing('9999')).toBeNull()
    expect(lookupBankByClearing('123')).toBeNull()
    expect(lookupBankByClearing('')).toBeNull()
  })
})

describe('lookupBicByClearing', () => {
  it('maps clearing numbers to the bank BIC', () => {
    expect(lookupBicByClearing('5000')).toBe('ESSESESS')  // SEB
    expect(lookupBicByClearing('6789')).toBe('HANDSESS')  // Handelsbanken
    expect(lookupBicByClearing('7123')).toBe('SWEDSESS')  // Swedbank
    expect(lookupBicByClearing('3000')).toBe('NDEASESS')  // Nordea
    expect(lookupBicByClearing('1234')).toBe('DABASESX')  // Danske Bank
  })
  it('maps a 5-digit Swedbank clearing via its 8xxx prefix', () => {
    expect(lookupBicByClearing('83279')).toBe('SWEDSESS')
  })
  it('returns null for unknown ranges rather than guessing a BIC', () => {
    expect(lookupBicByClearing('9999')).toBeNull()
    expect(lookupBicByClearing('123')).toBeNull()
    expect(lookupBicByClearing('')).toBeNull()
  })
})

describe('lookupBicByBankName', () => {
  it('resolves banks outside the clearing table by name', () => {
    expect(lookupBicByBankName('Länsförsäkringar')).toBe('ELLFSESS')
    expect(lookupBicByBankName('Skandiabanken')).toBe('SKIASESS')
  })
  it('matches on a normalized substring', () => {
    expect(lookupBicByBankName('Danske Bank Sverige')).toBe('DABASESX')
    expect(lookupBicByBankName('  SEB  ')).toBe('ESSESESS')
  })
  it('returns null for unknown or empty names', () => {
    expect(lookupBicByBankName('Min Lokala Bank')).toBeNull()
    expect(lookupBicByBankName('')).toBeNull()
    expect(lookupBicByBankName(null)).toBeNull()
  })
})
