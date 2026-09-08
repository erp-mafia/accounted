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
  resolveCompanyEntityType,
  resultClosingAccounts,
  simplifiedYearEndRegelverk,
  usesPersonnummerAsOrgNumber,
} from '@/lib/company/entity-type'

function stubSupabase(companyRow: { entity_type: string } | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: companyRow, error })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as unknown as SupabaseClient, from, eq }
}

describe('entity-type: parsing', () => {
  it('lists the three supported forms', () => {
    expect([...ENTITY_TYPES]).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening'])
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
    expect(byEntityType('ideell_forening', { enskild_firma: 1, aktiebolag: 2, ideell_forening: 3 })).toBe(3)
    expect(() =>
      byEntityType('stiftelse' as never, { enskild_firma: 1, aktiebolag: 2, ideell_forening: 3 }),
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
  })

  it('settles owner money on the form-specific account, 2890 for a förening', () => {
    expect(ownerSettlementAccount('enskild_firma', 'withdrawal')).toBe('2013')
    expect(ownerSettlementAccount('enskild_firma', 'contribution')).toBe('2018')
    expect(ownerSettlementAccount('aktiebolag', 'withdrawal')).toBe('2893')
    expect(ownerSettlementAccount('aktiebolag', 'contribution')).toBe('2893')
    expect(ownerSettlementAccount('ideell_forening', 'withdrawal')).toBe('2890')
    expect(ownerSettlementAccount('ideell_forening', 'contribution')).toBe('2890')
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
  })
})

describe('entity-type: creation flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hides ideell_forening until the flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(false)
    expect(isEntityTypeCreatable('aktiebolag')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag'])
  })

  it('offers ideell_forening when the flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening'])
  })
})
