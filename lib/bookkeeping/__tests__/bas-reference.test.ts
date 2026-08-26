import { describe, it, expect } from 'vitest'
import {
  BAS_REFERENCE,
  ACCOUNT_CLASS_LABELS,
  ACCOUNT_GROUP_LABELS,
  getBASReference,
  getBASReferenceByClass,
  isStandardBASAccount,
} from '../bas-reference'

describe('BAS_REFERENCE data integrity', () => {
  it('contains the expected number of accounts (~1,276)', () => {
    expect(BAS_REFERENCE.length).toBeGreaterThanOrEqual(1250)
    expect(BAS_REFERENCE.length).toBeLessThanOrEqual(1300)
  })

  it('has no duplicate account numbers', () => {
    const numbers = BAS_REFERENCE.map((a) => a.account_number)
    const uniqueNumbers = new Set(numbers)
    expect(uniqueNumbers.size).toBe(numbers.length)
  })

  it('account_class matches the first digit of account_number', () => {
    for (const account of BAS_REFERENCE) {
      const firstDigit = parseInt(account.account_number[0], 10)
      expect(account.account_class).toBe(firstDigit)
    }
  })

  it('account_group matches the first two digits of account_number', () => {
    for (const account of BAS_REFERENCE) {
      const firstTwo = account.account_number.substring(0, 2)
      expect(account.account_group).toBe(firstTwo)
    }
  })

  it('every account has a non-null sru_code', () => {
    const withoutSru = BAS_REFERENCE.filter((a) => a.sru_code === null)
    expect(withoutSru).toEqual([])
  })

  it('every account has a non-empty description', () => {
    const withoutDesc = BAS_REFERENCE.filter((a) => !a.description || a.description.trim() === '')
    expect(withoutDesc).toEqual([])
  })

  it('no account name or description has a concatenated group header', () => {
    const headerSuffix = /\s\d{2,}\s+[A-ZÅÄÖ]{2,}/
    const corrupted = BAS_REFERENCE.filter(
      (a) => headerSuffix.test(a.account_name) || headerSuffix.test(a.description ?? ''),
    )
    expect(corrupted).toEqual([])
  })

  it('every account has a valid account_type', () => {
    const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense', 'untaxed_reserves']
    for (const account of BAS_REFERENCE) {
      expect(validTypes).toContain(account.account_type)
    }
  })

  it('every account has a valid normal_balance', () => {
    for (const account of BAS_REFERENCE) {
      expect(['debit', 'credit']).toContain(account.normal_balance)
    }
  })

  it('all account numbers are 4 digits', () => {
    for (const account of BAS_REFERENCE) {
      expect(account.account_number).toMatch(/^\d{4}$/)
    }
  })
})

describe('Non-standard accounts removed', () => {
  const nonStandard = ['1400', '1580', '3109', '4100', '4990', '7834', '7835', '7910', '8710']

  for (const num of nonStandard) {
    it(`${num} is not in the catalog`, () => {
      expect(isStandardBASAccount(num)).toBe(false)
    })
  }
})

describe('Class 2 account_type correctness', () => {
  it('20xx accounts are equity', () => {
    const group20 = BAS_REFERENCE.filter((a) => a.account_group === '20')
    expect(group20.length).toBeGreaterThan(0)
    for (const a of group20) {
      expect(a.account_type).toBe('equity')
    }
  })

  it('21xx accounts are untaxed_reserves', () => {
    const group21 = BAS_REFERENCE.filter((a) => a.account_group === '21')
    expect(group21.length).toBeGreaterThan(0)
    for (const a of group21) {
      expect(a.account_type).toBe('untaxed_reserves')
    }
  })

  it('22xx-29xx accounts are liability', () => {
    const liabilityGroups = BAS_REFERENCE.filter(
      (a) => a.account_class === 2 && parseInt(a.account_group) >= 22
    )
    expect(liabilityGroups.length).toBeGreaterThan(0)
    for (const a of liabilityGroups) {
      expect(a.account_type).toBe('liability')
    }
  })
})

describe('Class 8 normal_balance correctness', () => {
  it('8310 (Ränteintäkter) has credit normal_balance', () => {
    const account = getBASReference('8310')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('credit')
  })

  it('8410 (Räntekostnader) has debit normal_balance', () => {
    const account = getBASReference('8410')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('debit')
  })

  it('8910 (Skatt) has debit normal_balance', () => {
    const account = getBASReference('8910')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('debit')
  })

  it('8810 (Bokslutsdispositioner) has credit normal_balance', () => {
    const account = getBASReference('8810')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('credit')
  })
})

describe('Contra accounts have opposite normal_balance', () => {
  it('1119 (Ack. avskrivningar byggnader) has credit balance', () => {
    const account = getBASReference('1119')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('credit')
  })

  it('1229 (Ack. avskrivningar inventarier) has credit balance', () => {
    const account = getBASReference('1229')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('credit')
  })

  it('2011 (Egna varuuttag) has debit balance', () => {
    const account = getBASReference('2011')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('debit')
  })

  it('3740 (Öres- och kronutjämning) has debit balance', () => {
    const account = getBASReference('3740')
    expect(account).toBeDefined()
    expect(account!.normal_balance).toBe('debit')
  })
})

describe('K2-excluded accounts', () => {
  const k2Excluded = [
    '1010', '1011', '1012', '1018', '1019',
    '1081',
    '1370', '1518',
    '2089', '2092', '2096', '2240', '2448',
    '3940', '7940',
    '8290', '8291', '8295',
    '8320', '8321', '8325',
    '8417',
    '8450', '8451', '8455',
    '8480', '8940',
  ]

  it('known K2-excluded accounts are marked correctly', () => {
    for (const num of k2Excluded) {
      const account = getBASReference(num)
      expect(account).toBeDefined()
      expect(account!.k2_excluded).toBe(true)
    }
  })

  it('common non-K2-excluded accounts are not marked', () => {
    const normalAccounts = ['1510', '1930', '2440', '3001', '4010', '5010', '7010', '8310']
    for (const num of normalAccounts) {
      const account = getBASReference(num)
      expect(account).toBeDefined()
      expect(account!.k2_excluded).toBe(false)
    }
  })

  it('total K2-excluded count matches expected (27)', () => {
    const k2Count = BAS_REFERENCE.filter((a) => a.k2_excluded).length
    expect(k2Count).toBe(27)
  })
})

describe('ACCOUNT_GROUP_LABELS coverage', () => {
  it('all groups present in BAS_REFERENCE have labels', () => {
    const groups = new Set(BAS_REFERENCE.map((a) => a.account_group))
    for (const group of groups) {
      expect(ACCOUNT_GROUP_LABELS[group]).toBeDefined()
    }
  })

  it('covers at least 70 groups', () => {
    expect(Object.keys(ACCOUNT_GROUP_LABELS).length).toBeGreaterThanOrEqual(70)
  })
})

describe('ACCOUNT_CLASS_LABELS', () => {
  it('has labels for all 8 classes', () => {
    for (let i = 1; i <= 8; i++) {
      expect(ACCOUNT_CLASS_LABELS[i]).toBeDefined()
    }
  })
})

describe('Helper functions', () => {
  it('getBASReference returns correct account', () => {
    const account = getBASReference('1930')
    expect(account).toBeDefined()
    expect(account!.account_name).toBe('Företagskonto')
    expect(account!.account_type).toBe('asset')
  })

  it('getBASReference returns undefined for non-existent account', () => {
    expect(getBASReference('9999')).toBeUndefined()
  })

  it('getBASReferenceByClass returns accounts for each class', () => {
    for (let cls = 1; cls <= 8; cls++) {
      const accounts = getBASReferenceByClass(cls)
      expect(accounts.length).toBeGreaterThan(0)
      for (const a of accounts) {
        expect(a.account_class).toBe(cls)
      }
    }
  })

  it('getBASReferenceByClass returns empty array for non-existent class', () => {
    expect(getBASReferenceByClass(9)).toEqual([])
  })

  it('isStandardBASAccount returns true for standard accounts', () => {
    expect(isStandardBASAccount('1510')).toBe(true)
    expect(isStandardBASAccount('3001')).toBe(true)
    expect(isStandardBASAccount('8999')).toBe(true)
  })

  it('isStandardBASAccount returns false for non-standard accounts', () => {
    expect(isStandardBASAccount('9999')).toBe(false)
    expect(isStandardBASAccount('0000')).toBe(false)
  })
})

describe('Account class distribution', () => {
  it('class 1 (assets) has ~230 accounts', () => {
    const cls = getBASReferenceByClass(1)
    expect(cls.length).toBeGreaterThanOrEqual(220)
    expect(cls.length).toBeLessThanOrEqual(240)
  })

  it('class 2 (equity & liabilities) has ~265 accounts', () => {
    const cls = getBASReferenceByClass(2)
    expect(cls.length).toBeGreaterThanOrEqual(255)
    expect(cls.length).toBeLessThanOrEqual(275)
  })

  it('class 3 (revenue) has ~100 accounts', () => {
    const cls = getBASReferenceByClass(3)
    expect(cls.length).toBeGreaterThanOrEqual(90)
    expect(cls.length).toBeLessThanOrEqual(110)
  })
})
