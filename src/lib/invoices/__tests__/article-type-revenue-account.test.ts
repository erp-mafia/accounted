import { describe, it, expect } from 'vitest'
import {
  ARTICLE_TYPE_REVENUE_ACCOUNT_NUMBERS,
  accountsWithBookedSales,
  articleTypeCandidateAccount,
  articleTypeHistoryWindow,
  deriveArticleTypeRevenueAccount,
  usableArticleTypeAccounts,
} from '@/lib/invoices/article-type-revenue-account'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'

const row = (
  account_number: string,
  account_name: string,
  default_vat_rate: number | null = null,
  default_vat_treatment: string | null = null,
) => ({ account_number, account_name, account_class: 3, default_vat_rate, default_vat_treatment })

describe('usableArticleTypeAccounts (crm#1661)', () => {
  it('accepts an account the momsdeklaration counts at its rate: configured momssats or a name stating it', () => {
    const usable = usableArticleTypeAccounts([
      row('3041', 'Försäljning tjänster', 0.25),
      row('3052', 'Försäljning varor inom Sverige, 12 % moms'),
    ])
    expect([...usable].sort()).toEqual(['3041', '3052'])
  })

  it('refuses an account the declaration cannot classify or classifies at another rate', () => {
    const usable = usableArticleTypeAccounts([
      row('3041', 'Arbetsintäkt'), // no rate configured, none in the name
      row('3043', 'Försäljning tjänster', 0.25), // configured 25 % on the 6 % slot
      row('3051', 'Försäljning varor 12 % moms'), // name states another rate
    ])
    expect(usable.size).toBe(0)
  })

  it('ignores accounts outside the tjänst/vara table', () => {
    expect(usableArticleTypeAccounts([row('3001', 'Försäljning inom Sverige, 25 % moms', 0.25)]).size).toBe(0)
  })

  it('derives only company accounts: none of them is a BAS 2026 reference account', () => {
    expect(ARTICLE_TYPE_REVENUE_ACCOUNT_NUMBERS.filter(isStandardBASAccount)).toEqual([])
  })
})

describe('deriveArticleTypeRevenueAccount (crm#1661)', () => {
  const usable = new Set(['3041', '3042', '3051'])
  const tjanst = { type: 'tjanst' as const, derives: true }
  const vara = { type: 'vara' as const, derives: true }

  it('picks the tjänst or vara account for the line rate when the company has it', () => {
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'standard_25', article: tjanst, usable })).toBe('3041')
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'standard_25', article: vara, usable })).toBe('3051')
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'reduced_12', article: tjanst, usable })).toBe('3042')
  })

  it('keeps null (the 3001-3003 default) when the company lacks the account', () => {
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'reduced_12', article: vara, usable })).toBeNull()
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'standard_25', article: tjanst, usable: new Set() })).toBeNull()
  })

  it('leaves momsfri, reverse charge and export lines on their statutory account', () => {
    for (const treatment of ['exempt', 'reverse_charge', 'reverse_charge_domestic', 'export'] as const) {
      expect(deriveArticleTypeRevenueAccount({ requested: null, treatment, article: tjanst, usable })).toBeNull()
    }
  })

  it('never touches a line without an article, an article without a type, or an article with its own account', () => {
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'standard_25', article: null, usable })).toBeNull()
    expect(deriveArticleTypeRevenueAccount({ requested: null, treatment: 'standard_25', article: { type: null, derives: true }, usable })).toBeNull()
    expect(deriveArticleTypeRevenueAccount({ requested: '3011', treatment: 'standard_25', article: { type: 'tjanst', derives: false }, usable })).toBe('3011')
  })

  it('keeps an explicit line account, including another type account at the same rate', () => {
    expect(deriveArticleTypeRevenueAccount({ requested: '3011', treatment: 'standard_25', article: tjanst, usable })).toBe('3011')
    expect(deriveArticleTypeRevenueAccount({ requested: '3051', treatment: 'standard_25', article: tjanst, usable })).toBe('3051')
  })

  it('re-derives a frozen type account when the line moved to another rate', () => {
    expect(deriveArticleTypeRevenueAccount({ requested: '3041', treatment: 'reduced_12', article: tjanst, usable })).toBe('3042')
    expect(deriveArticleTypeRevenueAccount({ requested: '3051', treatment: 'reduced_12', article: vara, usable })).toBeNull()
    expect(deriveArticleTypeRevenueAccount({ requested: '3041', treatment: 'exempt', article: tjanst, usable })).toBeNull()
  })
})

describe('articleTypeCandidateAccount (crm#1661)', () => {
  const tjanst = { type: 'tjanst' as const, derives: true }

  it('names the account a deriving line asks for, re-derived lines included', () => {
    expect(articleTypeCandidateAccount({ requested: null, treatment: 'standard_25', article: tjanst })).toBe('3041')
    expect(articleTypeCandidateAccount({ requested: '3041', treatment: 'reduced_6', article: tjanst })).toBe('3043')
  })

  it('names nothing for a kept account, a non-domestic line or an article with its own account', () => {
    expect(articleTypeCandidateAccount({ requested: '3011', treatment: 'standard_25', article: tjanst })).toBeNull()
    expect(articleTypeCandidateAccount({ requested: null, treatment: 'export', article: tjanst })).toBeNull()
    expect(articleTypeCandidateAccount({ requested: null, treatment: 'standard_25', article: { type: 'tjanst', derives: false } })).toBeNull()
    expect(articleTypeCandidateAccount({ requested: null, treatment: 'standard_25', article: null })).toBeNull()
  })
})

describe('articleTypeHistoryWindow (crm#1661)', () => {
  it('spans the räkenskapsår of the invoice date and the one before', () => {
    expect(articleTypeHistoryWindow('2026-11-04', 1)).toEqual({ from: '2025-01-01', to: '2026-12-31' })
    expect(articleTypeHistoryWindow('2026-03-10', 5)).toEqual({ from: '2024-05-01', to: '2026-04-30' })
    expect(articleTypeHistoryWindow('2026-05-01', 5)).toEqual({ from: '2025-05-01', to: '2027-04-30' })
  })

  it('falls back to a calendar year for an unknown start month, and to nothing for a malformed date', () => {
    expect(articleTypeHistoryWindow('2026-11-04', null)).toEqual({ from: '2025-01-01', to: '2026-12-31' })
    expect(articleTypeHistoryWindow('2026-11-04', 13)).toEqual({ from: '2025-01-01', to: '2026-12-31' })
    expect(articleTypeHistoryWindow('not-a-date', 1)).toBeNull()
  })
})

describe('accountsWithBookedSales (crm#1661)', () => {
  it('counts an account the company credited, also when it was later debited back', () => {
    const booked = accountsWithBookedSales([
      { account_number: '3041', credit: '1250.00' },
      { account_number: '3051', credit: '0' },
      { account_number: '3042', credit: null },
      { account_number: '3052', credit: 0.01 },
    ])
    expect([...booked].sort()).toEqual(['3041', '3052'])
  })
})
