import { getRevenueAccount } from '@/lib/bookkeeping/invoice-accounts'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENTITY_TYPES,
  UnknownEntityTypeError,
  byEntityType,
  creatableEntityTypes,
  defaultAccountingMethod,
  fiscalYearLockedToCalendar,
  isEntityType,
  isEntityTypeCreatable,
  ownerSettlementAccount,
  parseEntityType,
  preparesArsredovisning,
  requiresAuditorRegardlessOfSize,
  booksCurrentTax,
  resolveCompanyEntityType,
  resultClosingAccounts,
  simplifiedYearEndRegelverk,
  supportsAccountingFramework,
  supportsCorporateTaxDispositions,
  supportsMemberCapital,
  usesInk2,
  usesPersonnummerAsOrgNumber,
  templateAccountForForm,
} from '@/lib/company/entity-type'

function stubSupabase(companyRow: { entity_type: string } | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: companyRow, error })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as unknown as SupabaseClient, from, eq }
}

describe('entity-type: parsing', () => {
  it('lists the supported forms', () => {
    expect([...ENTITY_TYPES]).toEqual([
      'enskild_firma',
      'aktiebolag',
      'ideell_forening',
      'ekonomisk_forening',
    ])
  })

  it('narrows known values and rejects everything else', () => {
    expect(isEntityType('ideell_forening')).toBe(true)
    expect(isEntityType('handelsbolag')).toBe(false)
    expect(isEntityType(null)).toBe(false)
    expect(isEntityType(1930)).toBe(false)
    expect(parseEntityType('aktiebolag')).toBe('aktiebolag')
    expect(() => parseEntityType('handelsbolag')).toThrow(UnknownEntityTypeError)
    expect(() => parseEntityType(undefined)).toThrow(/expected one of/)
  })

  it('byEntityType refuses a corrupt value at runtime', () => {
    expect(byEntityType('ideell_forening', {
      enskild_firma: 1,
      aktiebolag: 2,
      ideell_forening: 3,
      ekonomisk_forening: 4,
    })).toBe(3)
    expect(() =>
      byEntityType('stiftelse' as never, {
        enskild_firma: 1,
        aktiebolag: 2,
        ideell_forening: 3,
        ekonomisk_forening: 4,
      }),
    ).toThrow(UnknownEntityTypeError)
  })
})

describe('entity-type: resolveCompanyEntityType', () => {
  it('uses a valid hint without touching the database', async () => {
    const { client, from } = stubSupabase(null)
    await expect(resolveCompanyEntityType(client, 'c1', 'ideell_forening')).resolves.toBe('ideell_forening')
    expect(from).not.toHaveBeenCalled()
  })

  it('falls back to companies.entity_type when the hint is missing', async () => {
    const { client, eq } = stubSupabase({ entity_type: 'enskild_firma' })
    await expect(resolveCompanyEntityType(client, 'c1', null)).resolves.toBe('enskild_firma')
    expect(eq).toHaveBeenCalledWith('id', 'c1')
  })

  it('never defaults: throws when neither source has a valid form', async () => {
    const { client } = stubSupabase(null)
    await expect(resolveCompanyEntityType(client, 'c1', undefined)).rejects.toThrow(UnknownEntityTypeError)
  })

  it('surfaces a read error instead of guessing', async () => {
    const { client } = stubSupabase(null, { message: 'boom' })
    await expect(resolveCompanyEntityType(client, 'c1')).rejects.toThrow(/boom/)
  })
})

describe('entity-type: domain facts', () => {
  it('closes the year to the equity account of each form', () => {
    expect(resultClosingAccounts('enskild_firma')).toEqual({
      closing: '2010',
      closingName: 'Eget kapital',
      priorYearCarry: null,
    })
    expect(resultClosingAccounts('aktiebolag')).toEqual({
      closing: '2099',
      closingName: 'Årets resultat',
      priorYearCarry: '2098',
    })
    expect(resultClosingAccounts('ideell_forening')).toEqual({
      closing: '2069',
      closingName: 'Årets resultat',
      priorYearCarry: '2068',
    })
    expect(resultClosingAccounts('ekonomisk_forening')).toEqual({
      closing: '2099',
      closingName: 'Årets resultat',
      priorYearCarry: '2098',
    })
  })

  it('settles owner money on the form-specific account, 2890 for a förening', () => {
    expect(ownerSettlementAccount('enskild_firma', 'withdrawal')).toBe('2013')
    expect(ownerSettlementAccount('enskild_firma', 'contribution')).toBe('2018')
    expect(ownerSettlementAccount('aktiebolag', 'withdrawal')).toBe('2893')
    expect(ownerSettlementAccount('aktiebolag', 'contribution')).toBe('2893')
    expect(ownerSettlementAccount('ideell_forening', 'withdrawal')).toBe('2890')
    expect(ownerSettlementAccount('ideell_forening', 'contribution')).toBe('2890')
    expect(ownerSettlementAccount('ekonomisk_forening', 'withdrawal')).toBe('2890')
    expect(ownerSettlementAccount('ekonomisk_forening', 'contribution')).toBe('2890')
  })

  it('keeps the form-specific defaults', () => {
    expect(preparesArsredovisning('aktiebolag')).toBe(true)
    expect(preparesArsredovisning('ideell_forening')).toBe(false)
    expect(fiscalYearLockedToCalendar('enskild_firma')).toBe(true)
    expect(fiscalYearLockedToCalendar('ideell_forening')).toBe(false)
    expect(usesPersonnummerAsOrgNumber('enskild_firma')).toBe(true)
    expect(usesPersonnummerAsOrgNumber('ideell_forening')).toBe(false)
    expect(defaultAccountingMethod('enskild_firma')).toBe('cash')
    expect(defaultAccountingMethod('ideell_forening')).toBe('accrual')
    expect(simplifiedYearEndRegelverk('ideell_forening')).toBe('K1')
    expect(simplifiedYearEndRegelverk('aktiebolag')).toBe('K2')
    expect(preparesArsredovisning('ekonomisk_forening')).toBe(true)
    expect(fiscalYearLockedToCalendar('ekonomisk_forening')).toBe(false)
    expect(usesPersonnummerAsOrgNumber('ekonomisk_forening')).toBe(false)
    expect(defaultAccountingMethod('ekonomisk_forening')).toBe('accrual')
    expect(simplifiedYearEndRegelverk('ekonomisk_forening')).toBe('K2')
    expect(usesInk2('ekonomisk_forening')).toBe(true)
    expect(supportsCorporateTaxDispositions('ekonomisk_forening')).toBe(true)
    expect(requiresAuditorRegardlessOfSize('ekonomisk_forening')).toBe(true)
    expect(supportsMemberCapital('ekonomisk_forening')).toBe(true)
    expect(supportsAccountingFramework('ekonomisk_forening', 'K2')).toBe(true)
    // K3 opens for the form with its own equity statement (phase 2).
    expect(supportsAccountingFramework('ekonomisk_forening', 'K3')).toBe(false)
    expect(requiresAuditorRegardlessOfSize('aktiebolag')).toBe(false)
    expect(supportsMemberCapital('aktiebolag')).toBe(false)
  })

  it('gives an ekonomisk förening the AB override accounts, with owner accounts on 2890', () => {
    expect(templateAccountForForm('ekonomisk_forening', '3100', '3004')).toBe('3004')
    expect(templateAccountForForm('ekonomisk_forening', '6991', '7610')).toBe('7610')
    expect(templateAccountForForm('ekonomisk_forening', '2013', '2893')).toBe('2890')
    expect(templateAccountForForm('ekonomisk_forening', '5410', undefined)).toBe('5410')
    // The three account resolvers must agree for the same posting.
    expect(getRevenueAccount('exempt', 'ekonomisk_forening')).toBe('3004')
    expect(getDefaultAccountForCategory('expense_education', 'ekonomisk_forening')).toBe('7610')
    // The ideell förening keeps its base-account behaviour.
    expect(templateAccountForForm('ideell_forening', '3100', '3004')).toBe('3100')
  })

  it('taxes an ekonomisk förening as a juridisk person, like an AB and unlike both other forms', () => {
    // IL 65 kap. 10 § (bolagsskatt), IL 30 kap. 5 § (periodiseringsfond 25 %)
    // and the INK2 return apply to the aktiebolag and the ekonomisk förening.
    for (const form of ['aktiebolag', 'ekonomisk_forening'] as const) {
      expect(usesInk2(form)).toBe(true)
      expect(booksCurrentTax(form)).toBe(true)
      expect(supportsCorporateTaxDispositions(form)).toBe(true)
      expect(preparesArsredovisning(form)).toBe(true)
    }
    for (const form of ['enskild_firma', 'ideell_forening'] as const) {
      expect(usesInk2(form)).toBe(false)
      expect(booksCurrentTax(form)).toBe(false)
      expect(supportsCorporateTaxDispositions(form)).toBe(false)
      expect(supportsAccountingFramework(form, 'K2')).toBe(false)
      expect(supportsAccountingFramework(form, 'K3')).toBe(false)
    }
  })
})

describe('entity-type: creation flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hides ideell_forening until the flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(false)
    expect(isEntityTypeCreatable('aktiebolag')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag'])
  })

  it('offers ideell_forening when the flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening'])
  })

  it('offers ekonomisk_forening only when its flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED', 'true')
    expect(isEntityTypeCreatable('ekonomisk_forening')).toBe(true)
    expect(creatableEntityTypes()).toEqual([
      'enskild_firma',
      'aktiebolag',
      'ekonomisk_forening',
    ])
  })
})
