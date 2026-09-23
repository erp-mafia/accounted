import { describe, it, expect } from 'vitest'
import { unstable_serialize } from 'swr'
import { buildReferenceFallback } from '../seed'
import { refKeys } from '../keys'
import type { CashAccount, CompanySettings, FiscalPeriod } from '@/types'

const periods = [{ id: 'p1' }] as unknown as FiscalPeriod[]
const cash = [{ id: 'a1' }] as unknown as CashAccount[]
const settings = { company_id: 'c1', company_name: 'Bolaget AB' } as unknown as CompanySettings

describe('buildReferenceFallback', () => {
  it('keys the seed exactly as the hooks key their cache entries', () => {
    const fallback = buildReferenceFallback('c1', { fiscalPeriods: periods, cashAccounts: cash, settings })
    expect(Object.keys(fallback).sort()).toEqual(
      [
        unstable_serialize(refKeys.fiscalPeriods('c1')),
        unstable_serialize(refKeys.cashAccounts('c1')),
        unstable_serialize(refKeys.companySettings('c1')),
      ].sort(),
    )
    expect(fallback[unstable_serialize(refKeys.fiscalPeriods('c1'))]).toBe(periods)
    expect(fallback[unstable_serialize(refKeys.cashAccounts('c1'))]).toBe(cash)
    expect(fallback[unstable_serialize(refKeys.companySettings('c1'))]).toBe(settings)
  })

  it('seeds a null settings row (no row yet) but omits settings when not fetched', () => {
    const withNull = buildReferenceFallback('c1', { fiscalPeriods: [], cashAccounts: [], settings: null })
    expect(withNull[unstable_serialize(refKeys.companySettings('c1'))]).toBeNull()

    const notFetched = buildReferenceFallback('c1', { fiscalPeriods: [], cashAccounts: [] })
    expect(unstable_serialize(refKeys.companySettings('c1')) in notFetched).toBe(false)
  })

  it('seeds nothing without an active company', () => {
    expect(buildReferenceFallback(null, { fiscalPeriods: periods, cashAccounts: cash, settings })).toEqual({})
  })
})
