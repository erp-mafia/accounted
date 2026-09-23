import { describe, it, expect } from 'vitest'
import { REFERENCE_KINDS, isReferenceKey, refKeys } from '../keys'

describe('refKeys', () => {
  it('returns null for every builder when there is no active company', () => {
    expect(refKeys.companySettings(null)).toBeNull()
    expect(refKeys.fiscalPeriods(null)).toBeNull()
    expect(refKeys.cashAccounts(null)).toBeNull()
    expect(refKeys.accounts(null)).toBeNull()
    expect(refKeys.dimensions(null)).toBeNull()
    expect(refKeys.bookingTemplates(null)).toBeNull()
    expect(refKeys.customers(null)).toBeNull()
    expect(refKeys.suppliers(null)).toBeNull()
    expect(refKeys.articles(null)).toBeNull()
  })

  it('puts the kind first and the company id second on every key', () => {
    const keys = [
      refKeys.companySettings('c1'),
      refKeys.fiscalPeriods('c1'),
      refKeys.cashAccounts('c1'),
      refKeys.accounts('c1'),
      refKeys.dimensions('c1'),
      refKeys.bookingTemplates('c1'),
      refKeys.customers('c1'),
      refKeys.suppliers('c1'),
      refKeys.articles('c1'),
    ]
    for (const key of keys) {
      expect(key).not.toBeNull()
      expect(REFERENCE_KINDS).toContain(key![0])
      expect(key![1]).toBe('c1')
    }
    expect(new Set(keys.map((k) => k![0])).size).toBe(keys.length)
  })

  it('keeps the legacy company_settings key shape used by useCompanySettings', () => {
    expect(refKeys.companySettings('c1')).toEqual(['company_settings', 'c1'])
  })

  it('varies the accounts and articles keys on their filter flag', () => {
    expect(refKeys.accounts('c1')).toEqual(['ref:accounts', 'c1', true])
    expect(refKeys.accounts('c1', false)).toEqual(['ref:accounts', 'c1', false])
    expect(refKeys.articles('c1')).toEqual(['ref:articles', 'c1', false])
    expect(refKeys.articles('c1', true)).toEqual(['ref:articles', 'c1', true])
  })
})

describe('isReferenceKey', () => {
  it('accepts keys from the builders and rejects everything else', () => {
    expect(isReferenceKey(refKeys.fiscalPeriods('c1'))).toBe(true)
    expect(isReferenceKey(['company_settings', 'c1'])).toBe(true)
    expect(isReferenceKey(['worklist-badges', 'c1'])).toBe(false)
    expect(isReferenceKey('/api/settings')).toBe(false)
    expect(isReferenceKey(null)).toBe(false)
  })
})
