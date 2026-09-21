import { describe, it, expect } from 'vitest'
import {
  normalizeBankNumber,
  isValidClearing,
  validateEmployeeBankAccount,
  lookupBankByClearing,
  lookupBicByClearing,
  lookupBicByBankName,
  resolveDomesticBankAccount,
  payeeAccountProblem,
  payeeAccountParts,
  describePayeeAccountProblems,
  employeeBankDetailsRemark,
  PayeeAccountError,
} from '@/lib/salary/payment/bank-account'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Every number in this file is invented.

describe('resolveDomesticBankAccount', () => {
  it('passes a 4-digit clearing + account through unchanged', () => {
    expect(resolveDomesticBankAccount('6000', '1234567')).toEqual({
      ok: true,
      clearing4: '6000',
      accountDigits: '1234567',
      fitsBgLb: true,
    })
  })

  it('carries the 5th digit of a Swedbank clearing as the leading account digit', () => {
    expect(resolveDomesticBankAccount('83271', '123456789')).toEqual({
      ok: true,
      clearing4: '8327',
      accountDigits: '1123456789',
      fitsBgLb: true,
    })
  })

  it('resolves a 5-digit clearing with a 10-digit account, and says it does not fit the LB field', () => {
    expect(resolveDomesticBankAccount('83279', '1234567890')).toEqual({
      ok: true,
      clearing4: '8327',
      accountDigits: '91234567890',
      fitsBgLb: false,
    })
  })

  it('strips the redundant clearing prefix from an 11-digit personkonto', () => {
    expect(resolveDomesticBankAccount('1708', '17082042825')).toEqual({
      ok: true,
      clearing4: '1708',
      accountDigits: '2042825',
      fitsBgLb: true,
    })
  })

  it('refuses an 11-digit account that does not repeat the clearing', () => {
    // No bank in the clearing table has an 11-digit account without its
    // clearing (a personkonto is 10), and no file format here can carry one.
    // It used to be accepted at entry and then fail the whole LB file.
    expect(resolveDomesticBankAccount('3300', '19850101234')).toEqual({
      ok: false,
      problem: 'account_format',
    })
    expect(resolveDomesticBankAccount('83279', '83279123456')).toEqual({
      ok: false,
      problem: 'account_format',
    })
  })

  it('normalizes hyphens and spaces before resolving', () => {
    expect(resolveDomesticBankAccount('8327-1', '123 456 78-9')).toEqual({
      ok: true,
      clearing4: '8327',
      accountDigits: '1123456789',
      fitsBgLb: true,
    })
  })

  it('never drops a stray character and pays the digits that remain', () => {
    expect(resolveDomesticBankAccount('6000', '12a4567')).toEqual({ ok: false, problem: 'account_format' })
    expect(resolveDomesticBankAccount('60o0', '1234567')).toEqual({ ok: false, problem: 'clearing_format' })
  })

  it('refuses an invalid clearing number', () => {
    expect(resolveDomesticBankAccount('123', '1234567')).toEqual({ ok: false, problem: 'clearing_format' })
    expect(resolveDomesticBankAccount('12345', '1234567')).toEqual({ ok: false, problem: 'clearing_format' })
    expect(resolveDomesticBankAccount(null, '1234567')).toEqual({ ok: false, problem: 'clearing_format' })
  })

  it('refuses an account that is too short, too long or missing', () => {
    expect(resolveDomesticBankAccount('6000', '1234')).toEqual({ ok: false, problem: 'account_format' })
    expect(resolveDomesticBankAccount('6000', '123456789012')).toEqual({ ok: false, problem: 'account_format' })
    expect(resolveDomesticBankAccount('6000', undefined)).toEqual({ ok: false, problem: 'account_format' })
  })
})

describe('payeeAccountProblem', () => {
  it('is null when the format carries the account', () => {
    expect(payeeAccountProblem('6000', '1234567', 'bg_lb')).toBeNull()
    expect(payeeAccountProblem('6000', '1234567', 'pain001')).toBeNull()
    expect(payeeAccountProblem('83279', '1234567890', 'pain001')).toBeNull()
  })

  it('names the LB field width for a 5-digit clearing with a 10-digit account', () => {
    expect(payeeAccountProblem('83279', '1234567890', 'bg_lb')).toBe('bg_lb_account_too_long')
  })

  it('reports an unresolvable pair the same way for every format', () => {
    expect(payeeAccountProblem('3300', '19850101234', 'bg_lb')).toBe('account_format')
    expect(payeeAccountProblem('3300', '19850101234', 'pain001')).toBe('account_format')
    expect(payeeAccountProblem('123', '1234567', 'pain001')).toBe('clearing_format')
  })
})

describe('PayeeAccountError', () => {
  it('names the payee and the fix, and never the clearing or account number', () => {
    let caught: unknown
    try {
      payeeAccountParts('Sara Svensson', '83279', '9612345678', 'bg_lb')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PayeeAccountError)
    const error = caught as PayeeAccountError
    expect(error.payeeName).toBe('Sara Svensson')
    expect(error.problem).toBe('bg_lb_account_too_long')
    expect(error.message).toContain('Sara Svensson')
    expect(error.message).toContain('pain.001')
    // 'ISO 20022' is the only digit run allowed in the text.
    expect(error.message.replace('ISO 20022', '')).not.toMatch(/\d{4,}/)
  })

  it('returns the routing parts when the format carries the account', () => {
    expect(payeeAccountParts('Sara Svensson', '83279', '9612345678', 'pain001')).toEqual({
      clearing4: '8327',
      accountDigits: '99612345678',
      fitsBgLb: false,
    })
  })
})

describe('PayeeAccountError through getErrorMessage (the GENERATOR_FAILED backstop)', () => {
  it.each(['clearing_format', 'account_format', 'bg_lb_account_too_long'] as const)(
    'keeps the named Swedish text for %s',
    (problem) => {
      const error = new PayeeAccountError('Sara Svensson', problem)
      expect(getErrorMessage(error, { context: 'salary' })).toBe(error.message)
    },
  )
})

describe('describePayeeAccountProblems', () => {
  it('groups payees by problem into one sentence each', () => {
    const text = describePayeeAccountProblems([
      { name: 'Anna Ek', problem: 'bg_lb_account_too_long' },
      { name: 'Bo Ek', problem: 'account_format' },
      { name: 'Cia Ek', problem: 'bg_lb_account_too_long' },
    ])
    expect(text).toContain('Anna Ek, Cia Ek: kontonumret ryms inte i Bankgirot LB-filen')
    expect(text).toContain('Bo Ek: kontonumret är ogiltigt')
  })
})

describe('employeeBankDetailsRemark', () => {
  it('is null for a payable pair, including the one the LB field cannot hold', () => {
    expect(employeeBankDetailsRemark('Anna Ek', '6000', '1234567')).toBeNull()
    expect(employeeBankDetailsRemark('Sara Svensson', '8327-9', '9612345678')).toBeNull()
  })

  it('says details are missing when either field is empty', () => {
    expect(employeeBankDetailsRemark('Anna Ek', null, '1234567')).toBe(
      'Anna Ek: Bankuppgifter saknas (clearingnummer och/eller kontonummer)',
    )
    expect(employeeBankDetailsRemark('Anna Ek', '6000', '')).toContain('Bankuppgifter saknas')
  })

  it('names the employee and the fix for stored details that name no payable account', () => {
    const remark = employeeBankDetailsRemark('Lena Lund', '5037', '96123456789')
    expect(remark).toBe('Lena Lund: kontonumret är ogiltigt (5-10 siffror, utan clearingnummer). Rätta bankuppgifterna.')
    expect(remark).not.toContain('96123456789')
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
    expect(validateEmployeeBankAccount('6000', '12a4567').map((i) => i.code)).toEqual(['account_format'])
  })

  it('accepts accounts of 5 to 10 digits', () => {
    expect(validateEmployeeBankAccount('6000', '12345')).toEqual([])
    expect(validateEmployeeBankAccount('3300', '8501011234')).toEqual([])
    expect(validateEmployeeBankAccount('83279', '9612345678')).toEqual([])
  })

  it('accepts an 11-digit account only when it repeats the 4-digit clearing', () => {
    expect(validateEmployeeBankAccount('1708', '17082042825')).toEqual([])
    const issues = validateEmployeeBankAccount('3300', '19850101234')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ field: 'bank_account_number', code: 'account_format' })
    expect(issues[0].message).toBe('Kontonummer måste vara 5-10 siffror, utan clearingnummer')
  })

  it('judges the account with its clearing: 11 digits under a 5-digit clearing is refused', () => {
    expect(validateEmployeeBankAccount('83279', '83279123456').map((i) => i.code)).toEqual(['account_format'])
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
