import { describe, it, expect } from 'vitest'
import type { BASAccount } from '@/types'
import type { BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'
import type { SIEAccount, SIEAccountMappingRecord } from '../types'
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import {
  suggestMappings,
  validateMappings,
  getMappingStats,
  applyMappingOverride,
  mappingsToMap,
  isSystemAccount,
} from '../account-mapper'

// --- Helpers ---

function makeBASAccount(number: string, name: string): BASAccount {
  const classNum = parseInt(number.charAt(0), 10)
  const classified = classifyAccount(number)
  return {
    id: `bas-${number}`,
    user_id: 'user-1',
    company_id: 'company-1',
    account_number: number,
    account_name: name,
    account_class: classNum,
    account_group: number.substring(0, 2),
    account_type: classified.account_type,
    normal_balance: classified.normal_balance,
    plan_type: 'k1',
    is_active: true,
    is_system_account: false,
    default_vat_code: null,
    default_vat_rate: null,
    description: null,
    sru_code: null,
    k2_excluded: false,
    sort_order: parseInt(number, 10),
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  }
}

function makeSIEAccount(number: string, name: string): SIEAccount {
  return { number, name }
}

// --- Fixtures ---

const basAccounts: BASAccount[] = [
  makeBASAccount('1510', 'Kundfordringar'),
  makeBASAccount('1930', 'Företagskonto'),
  makeBASAccount('2440', 'Leverantörsskulder'),
  makeBASAccount('2640', 'Ingående moms'),
  makeBASAccount('2641', 'Debiterad ingående moms'),
  makeBASAccount('3001', 'Försäljning varor 25%'),
  makeBASAccount('3002', 'Försäljning varor 12%'),
  makeBASAccount('5010', 'Lokalhyra'),
  makeBASAccount('6211', 'Telekommunikation'),
]

// --- Tests ---

describe('suggestMappings', () => {
  it('returns exact match with confidence 1.0', () => {
    const source = [makeSIEAccount('1510', 'Kundfordringar')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('1510')
    expect(result[0].targetName).toBe('Kundfordringar')
    expect(result[0].confidence).toBe(1.0)
    expect(result[0].matchType).toBe('exact')
    expect(result[0].isOverride).toBe(false)
  })

  it('returns unmapped entry for out-of-range accounts', () => {
    const source = [makeSIEAccount('9999', 'Okänt konto')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('')
    expect(result[0].targetName).toBe('')
    expect(result[0].confidence).toBe(0)
    expect(result[0].matchType).toBe('manual')
  })

  it('self-maps valid BAS-range accounts not in reference via bas_range fallback', () => {
    // 3400 is a valid BAS-range account (1000-8999) but not in the fixture list
    const source = [makeSIEAccount('3400', 'Försäljning tjänster')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('3400')
    expect(result[0].targetName).toBe('Försäljning tjänster')
    expect(result[0].confidence).toBe(0.7)
    expect(result[0].matchType).toBe('bas_range')
  })

  it('self-maps sub-accounts not in reference (e.g. 1241 Personbilar)', () => {
    const source = [makeSIEAccount('1241', 'Personbilar')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('1241')
    expect(result[0].targetName).toBe('Personbilar')
    expect(result[0].confidence).toBe(0.7)
    expect(result[0].matchType).toBe('bas_range')
  })

  it('does not self-map accounts outside BAS range (9000+)', () => {
    const source = [makeSIEAccount('9100', 'Internt konto')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('')
    expect(result[0].confidence).toBe(0)
  })

  it('does not self-map non-4-digit account numbers', () => {
    const source = [makeSIEAccount('12345', 'Felaktigt kontonummer')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('')
    expect(result[0].confidence).toBe(0)
  })

  it('preserves user overrides from existing mappings', () => {
    const source = [makeSIEAccount('3400', 'Försäljning tjänster')]
    const existingMappings: SIEAccountMappingRecord[] = [
      {
        id: 'map-1',
        user_id: 'user-1',
        source_account: '3400',
        source_name: 'Försäljning tjänster',
        target_account: '3001',
        confidence: 1.0,
        match_type: 'manual',
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      },
    ]

    const result = suggestMappings(source, basAccounts, existingMappings)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('3001')
    expect(result[0].isOverride).toBe(true)
    expect(result[0].matchType).toBe('manual')
  })

  it('sorts by confidence (lowest first)', () => {
    const source = [
      makeSIEAccount('1510', 'Kundfordringar'),
      makeSIEAccount('9999', 'Okänt konto'),
      makeSIEAccount('3400', 'Försäljning tjänster'),
      makeSIEAccount('1930', 'Företagskonto'),
    ]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(4)
    // Unmapped (confidence 0) should come first
    expect(result[0].sourceAccount).toBe('9999')
    expect(result[0].confidence).toBe(0)
    // bas_range (confidence 0.7) next
    expect(result[1].sourceAccount).toBe('3400')
    expect(result[1].confidence).toBe(0.7)
    // Exact matches (confidence 1.0) come last
    expect(result[2].confidence).toBe(1.0)
    expect(result[3].confidence).toBe(1.0)
  })

  it('handles multiple accounts with mixed results', () => {
    const source = [
      makeSIEAccount('1510', 'Kundfordringar'),
      makeSIEAccount('3400', 'Försäljning tjänster'),
      makeSIEAccount('5010', 'Lokalhyra'),
    ]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(3)

    // All 3 should be mapped: 1510 and 5010 exact, 3400 bas_range
    const mapped = result.filter((m) => m.targetAccount)
    expect(mapped).toHaveLength(3)
    expect(mapped.find((m) => m.sourceAccount === '3400')?.matchType).toBe('bas_range')
  })

  it('handles empty source accounts', () => {
    const result = suggestMappings([], basAccounts)
    expect(result).toHaveLength(0)
  })

  it('redirects group header account 2640 to posting account 2641', () => {
    const source = [makeSIEAccount('2640', 'Ingående moms')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].sourceAccount).toBe('2640')
    expect(result[0].targetAccount).toBe('2641')
    expect(result[0].targetName).toBe('Debiterad ingående moms')
    expect(result[0].confidence).toBe(1.0)
    expect(result[0].matchType).toBe('exact')
  })

  it('does not redirect 2641 (it is the posting account, not a group header)', () => {
    const source = [makeSIEAccount('2641', 'Debiterad ingående moms')]
    const result = suggestMappings(source, basAccounts)

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('2641')
  })

  it('handles empty BAS accounts: bas_range fallback for valid accounts', () => {
    const source = [makeSIEAccount('1510', 'Kundfordringar')]
    const result = suggestMappings(source, [])

    expect(result).toHaveLength(1)
    expect(result[0].targetAccount).toBe('1510')
    expect(result[0].confidence).toBe(0.7)
    expect(result[0].matchType).toBe('bas_range')
  })

  it('accepts BASReferenceAccount objects (full BAS reference)', () => {
    const refAccounts: BASReferenceAccount[] = [
      {
        account_number: '1510',
        account_name: 'Kundfordringar',
        account_class: 1,
        account_group: '15',
        account_type: 'asset',
        normal_balance: 'debit',
        description: 'Kundfordringar',
        sru_code: null,
        k2_excluded: false,
      },
      {
        account_number: '2440',
        account_name: 'Leverantörsskulder',
        account_class: 2,
        account_group: '24',
        account_type: 'liability',
        normal_balance: 'credit',
        description: 'Leverantörsskulder',
        sru_code: null,
        k2_excluded: false,
      },
    ]

    const source = [
      makeSIEAccount('1510', 'Kundfordringar'),
      makeSIEAccount('2440', 'Leverantörsskulder'),
      makeSIEAccount('9999', 'Okänt konto'),
    ]

    const result = suggestMappings(source, refAccounts)

    expect(result).toHaveLength(3)
    const mapped = result.filter((m) => m.targetAccount)
    const unmapped = result.filter((m) => !m.targetAccount)
    expect(mapped).toHaveLength(2)
    expect(unmapped).toHaveLength(1)
    expect(mapped.find((m) => m.sourceAccount === '1510')?.confidence).toBe(1.0)
  })
})

describe('validateMappings', () => {
  it('returns valid when all accounts are mapped', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('1510', 'Kundfordringar'), makeSIEAccount('1930', 'Företagskonto')],
      basAccounts
    )
    const validation = validateMappings(mappings)

    expect(validation.valid).toBe(true)
    expect(validation.unmappedAccounts).toHaveLength(0)
  })

  it('returns invalid when out-of-range accounts are unmapped', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('1510', 'Kundfordringar'), makeSIEAccount('9999', 'Okänt konto')],
      basAccounts
    )
    const validation = validateMappings(mappings)

    expect(validation.valid).toBe(false)
    expect(validation.unmappedAccounts).toContain('9999')
    expect(validation.unmappedAccounts).toHaveLength(1)
  })

  it('returns valid when all accounts mapped via exact + bas_range', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('1510', 'Kundfordringar'), makeSIEAccount('1241', 'Personbilar')],
      basAccounts
    )
    const validation = validateMappings(mappings)

    expect(validation.valid).toBe(true)
    expect(validation.unmappedAccounts).toHaveLength(0)
  })

  it('detects low confidence accounts', () => {
    // With exact-match-only mapper, low confidence only comes from existing overrides
    const mappings = [
      {
        sourceAccount: '3400',
        sourceName: 'Försäljning tjänster',
        targetAccount: '3001',
        targetName: 'Försäljning varor 25%',
        confidence: 0.3,
        matchType: 'class' as const,
        isOverride: false,
      },
    ]

    const validation = validateMappings(mappings)
    expect(validation.lowConfidenceAccounts).toContain('3400')
  })
})

describe('getMappingStats', () => {
  it('counts total, mapped, unmapped correctly', () => {
    const mappings = suggestMappings(
      [
        makeSIEAccount('1510', 'Kundfordringar'),
        makeSIEAccount('9999', 'Okänt konto'),
        makeSIEAccount('5010', 'Lokalhyra'),
      ],
      basAccounts
    )
    const stats = getMappingStats(mappings)

    expect(stats.total).toBe(3)
    expect(stats.mapped).toBe(2)
    expect(stats.unmapped).toBe(1)
  })

  it('counts match types correctly including bas_range', () => {
    const mappings = suggestMappings(
      [
        makeSIEAccount('1510', 'Kundfordringar'),   // exact
        makeSIEAccount('1241', 'Personbilar'),       // bas_range
        makeSIEAccount('9999', 'Okänt konto'),       // manual (unmapped)
      ],
      basAccounts
    )
    const stats = getMappingStats(mappings)

    expect(stats.exact).toBe(1)
    expect(stats.basRange).toBe(1)
    expect(stats.manual).toBe(1)
    expect(stats.name).toBe(0)
    expect(stats.class).toBe(0)
  })

  it('calculates average confidence for mapped accounts only', () => {
    const mappings = suggestMappings(
      [
        makeSIEAccount('1510', 'Kundfordringar'), // exact, confidence 1.0
        makeSIEAccount('1930', 'Företagskonto'),   // exact, confidence 1.0
        makeSIEAccount('9999', 'Okänt konto'),     // unmapped, confidence 0
      ],
      basAccounts
    )
    const stats = getMappingStats(mappings)

    // Average of mapped only: (1.0 + 1.0) / 2 = 1.0
    expect(stats.averageConfidence).toBe(1.0)
  })

  it('includes bas_range in average confidence calculation', () => {
    const mappings = suggestMappings(
      [
        makeSIEAccount('1510', 'Kundfordringar'), // exact, confidence 1.0
        makeSIEAccount('1241', 'Personbilar'),     // bas_range, confidence 0.9
      ],
      basAccounts
    )
    const stats = getMappingStats(mappings)

    // Average of (1.0 + 0.7) / 2 = 0.85
    expect(stats.averageConfidence).toBe(0.85)
  })

  it('returns 0 average confidence when nothing is mapped', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('9999', 'Okänt konto')],
      basAccounts
    )
    const stats = getMappingStats(mappings)
    expect(stats.averageConfidence).toBe(0)
  })
})

describe('applyMappingOverride', () => {
  it('sets target, confidence 1.0, matchType manual, and isOverride', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('3400', 'Försäljning tjänster')],
      basAccounts
    )

    const updated = applyMappingOverride(mappings, '3400', '3001', 'Försäljning varor 25%')

    expect(updated).toHaveLength(1)
    expect(updated[0].targetAccount).toBe('3001')
    expect(updated[0].targetName).toBe('Försäljning varor 25%')
    expect(updated[0].confidence).toBe(1.0)
    expect(updated[0].matchType).toBe('manual')
    expect(updated[0].isOverride).toBe(true)
  })

  it('does not mutate the original array', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('3400', 'Försäljning tjänster')],
      basAccounts
    )
    const original = [...mappings]

    applyMappingOverride(mappings, '3400', '3001', 'Försäljning varor 25%')

    expect(mappings[0].targetAccount).toBe(original[0].targetAccount)
    expect(mappings[0].confidence).toBe(original[0].confidence)
  })

  it('only affects the specified source account', () => {
    const mappings = suggestMappings(
      [
        makeSIEAccount('3400', 'Försäljning tjänster'),
        makeSIEAccount('9998', 'Annat okänt konto'),
      ],
      basAccounts
    )

    const updated = applyMappingOverride(mappings, '3400', '3001', 'Försäljning varor 25%')

    const unchanged = updated.find((m) => m.sourceAccount === '9998')
    expect(unchanged?.targetAccount).toBe('')
    expect(unchanged?.confidence).toBe(0)
  })
})

describe('mappingsToMap', () => {
  it('creates a Map from source to target account', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('1510', 'Kundfordringar'), makeSIEAccount('1930', 'Företagskonto')],
      basAccounts
    )
    const map = mappingsToMap(mappings)

    expect(map.get('1510')).toBe('1510')
    expect(map.get('1930')).toBe('1930')
    expect(map.size).toBe(2)
  })

  it('skips unmapped accounts', () => {
    const mappings = suggestMappings(
      [makeSIEAccount('1510', 'Kundfordringar'), makeSIEAccount('9999', 'Okänt konto')],
      basAccounts
    )
    const map = mappingsToMap(mappings)

    expect(map.get('1510')).toBe('1510')
    expect(map.has('9999')).toBe(false)
    expect(map.size).toBe(1)
  })
})

describe('isSystemAccount', () => {
  it('returns true for Fortnox system account 0099', () => {
    expect(isSystemAccount('0099')).toBe(true)
  })

  it('returns true for other 0xxx accounts', () => {
    expect(isSystemAccount('0001')).toBe(true)
    expect(isSystemAccount('0500')).toBe(true)
    expect(isSystemAccount('0999')).toBe(true)
  })

  it('returns false for valid BAS accounts (1000-8999)', () => {
    expect(isSystemAccount('1000')).toBe(false)
    expect(isSystemAccount('1510')).toBe(false)
    expect(isSystemAccount('3001')).toBe(false)
    expect(isSystemAccount('8999')).toBe(false)
  })

  it('returns false for 9000+ accounts (handled separately as out-of-range)', () => {
    expect(isSystemAccount('9000')).toBe(false)
    expect(isSystemAccount('9999')).toBe(false)
  })

  it('returns false for non-4-digit numbers', () => {
    expect(isSystemAccount('099')).toBe(false)
    expect(isSystemAccount('00099')).toBe(false)
    expect(isSystemAccount('abc')).toBe(false)
    expect(isSystemAccount('')).toBe(false)
  })

  it('allows pre-filtering system accounts before suggestMappings', () => {
    const allAccounts = [
      makeSIEAccount('0099', 'Systemkonto'),
      makeSIEAccount('1510', 'Kundfordringar'),
      makeSIEAccount('1930', 'Företagskonto'),
    ]

    const bookkeepingAccounts = allAccounts.filter((a) => !isSystemAccount(a.number))
    const excluded = allAccounts.filter((a) => isSystemAccount(a.number))

    expect(bookkeepingAccounts).toHaveLength(2)
    expect(excluded).toHaveLength(1)
    expect(excluded[0].number).toBe('0099')

    const mappings = suggestMappings(bookkeepingAccounts, basAccounts)
    expect(mappings).toHaveLength(2)
    expect(mappings.every((m) => m.targetAccount)).toBe(true)
  })
})
