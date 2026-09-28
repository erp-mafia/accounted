import { describe, expect, it } from 'vitest'
import {
  capCompanies,
  excludeCompanies,
  normalizeCompanyId,
  pickEmbedded,
  selectExplicitCompanies,
  sortCompaniesByName,
} from '../scope-utils'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function company(companyId: string, name: string) {
  return { companyId, name }
}

describe('pickEmbedded', () => {
  it('returns an object embed as-is', () => {
    expect(pickEmbedded({ id: A })).toEqual({ id: A })
  })

  it('returns the first element of an array embed', () => {
    expect(pickEmbedded([{ id: A }, { id: B }])).toEqual({ id: A })
  })

  it('returns null for null, undefined and an empty array', () => {
    expect(pickEmbedded(null)).toBeNull()
    expect(pickEmbedded(undefined)).toBeNull()
    expect(pickEmbedded([])).toBeNull()
  })
})

describe('normalizeCompanyId', () => {
  it('lower-cases and trims a UUID-shaped id', () => {
    expect(normalizeCompanyId(`  ${A.toUpperCase()} `)).toBe(A)
  })

  it('returns null for anything that is not UUID-shaped', () => {
    expect(normalizeCompanyId('acme')).toBeNull()
    expect(normalizeCompanyId('')).toBeNull()
    expect(normalizeCompanyId('1111-2222')).toBeNull()
  })
})

describe('selectExplicitCompanies', () => {
  const accessible = new Map([
    [A, company(A, 'Alpha')],
    [B, company(B, 'Beta')],
  ])

  it('keeps the requested order and drops repeats', () => {
    const { selected, unresolved } = selectExplicitCompanies([B, A, B], accessible)
    expect(selected.map((c) => c.companyId)).toEqual([B, A])
    expect(unresolved).toEqual([])
  })

  it('reports ids that are not accessible, malformed ids included', () => {
    const { selected, unresolved } = selectExplicitCompanies([A, C, 'not-a-uuid'], accessible)
    expect(selected.map((c) => c.companyId)).toEqual([A])
    expect(unresolved).toEqual([C, 'not-a-uuid'])
  })

  it('matches ids case-insensitively and skips empty fragments', () => {
    const { selected, unresolved } = selectExplicitCompanies(
      ['', '  ', A.toUpperCase(), ` ${B} `],
      accessible,
    )
    expect(selected.map((c) => c.companyId)).toEqual([A, B])
    expect(unresolved).toEqual([])
  })
})

describe('excludeCompanies', () => {
  const companies = [company(A, 'Alpha'), company(B, 'Beta'), company(C, 'Gamma')]

  it('returns a copy when nothing is excluded', () => {
    const out = excludeCompanies(companies, undefined)
    expect(out).toEqual(companies)
    expect(out).not.toBe(companies)
    expect(excludeCompanies(companies, [])).toEqual(companies)
  })

  it('removes the excluded ids regardless of case', () => {
    expect(excludeCompanies(companies, [B.toUpperCase(), ` ${C} `]).map((c) => c.companyId)).toEqual([A])
  })
})

describe('sortCompaniesByName', () => {
  it('sorts by name with Swedish collation (Å Ä Ö after Z)', () => {
    const sorted = sortCompaniesByName([
      company(A, 'Örebro Bygg'),
      company(B, 'Zeta AB'),
      company(C, 'Ängen'),
    ])
    expect(sorted.map((c) => c.name)).toEqual(['Zeta AB', 'Ängen', 'Örebro Bygg'])
  })

  it('breaks name ties on the id and leaves the input untouched', () => {
    const input = [company(B, 'Same'), company(A, 'Same')]
    const sorted = sortCompaniesByName(input)
    expect(sorted.map((c) => c.companyId)).toEqual([A, B])
    expect(input.map((c) => c.companyId)).toEqual([B, A])
  })
})

describe('capCompanies', () => {
  const companies = [company(A, 'Alpha'), company(B, 'Beta'), company(C, 'Gamma')]

  it('passes through at or under the cap', () => {
    expect(capCompanies(companies, 3)).toEqual({
      companies,
      truncated: false,
      remainingCompanyIds: [],
    })
    expect(capCompanies(companies, 10).truncated).toBe(false)
  })

  it('cuts at the cap and lists the remaining ids in order', () => {
    expect(capCompanies(companies, 2)).toEqual({
      companies: companies.slice(0, 2),
      truncated: true,
      remainingCompanyIds: [C],
    })
  })
})
