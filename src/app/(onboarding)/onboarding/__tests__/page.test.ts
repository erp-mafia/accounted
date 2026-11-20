import { describe, it, expect, vi } from 'vitest'
import { findCompanyRoleByOrgNumber, findCompanyRoleByPick, findOwnCompanyByOrgNumber } from '../page'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'

// `findCompanyRoleByOrgNumber` replaces the old prefetchLookup at /onboarding.
// It reads bankid_enrichment.company_roles (populated by TIC Identity API at
// BankID-completion time) and matches the role by orgnr. This costs zero
// Lens calls: Identity API is on a different TIC product/quota. These tests
// pin the behaviour because regressing this would silently re-add Lens spend
// to every BankID signup.

function makeRole(overrides: Partial<EnrichmentCompanyRole> = {}): EnrichmentCompanyRole {
  return {
    companyId: 12345,
    companyRegistrationNumber: '5560125790',
    legalName: 'Acme AB',
    legalEntityType: 'Aktiebolag',
    positionTypes: ['boardMember'],
    positionDescriptions: ['Styrelseledamot'],
    positionStart: '2020-01-01',
    positionEnd: null,
    companyStatus: 'isActive',
    ...overrides,
  }
}

function mockSupabase(rolesData: EnrichmentCompanyRole[] | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: rolesData === null ? null : { company_roles: rolesData },
            error: null,
          }),
        }),
      }),
    }),
  }
}

describe('findCompanyRoleByOrgNumber', () => {
  it('returns the matching role for a clean 10-digit orgnr', async () => {
    const supabase = mockSupabase([
      makeRole({ companyRegistrationNumber: '5560125790', legalName: 'Acme AB' }),
      makeRole({ companyRegistrationNumber: '5567890123', legalName: 'Other AB' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toMatchObject({ legalName: 'Acme AB', legalEntityType: 'Aktiebolag' })
  })

  it('matches orgnrs with hyphens stripped (TIC returns "556012-5790")', async () => {
    // CompanyRoles may carry the orgnr in formatted form; the function under
    // test cleans the registered form before comparing to the cleaned input.
    const supabase = mockSupabase([
      makeRole({ companyRegistrationNumber: '556012-5790', legalName: 'Acme AB' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toMatchObject({ legalName: 'Acme AB', legalEntityType: 'Aktiebolag' })
  })

  it('returns null when no enrichment row exists (user signed up without BankID)', async () => {
    const supabase = mockSupabase(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toBeNull()
  })

  it('returns null when enrichment row has an empty company_roles array', async () => {
    const supabase = mockSupabase([])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toBeNull()
  })

  it('returns null when none of the roles match the requested orgnr', async () => {
    const supabase = mockSupabase([
      makeRole({ companyRegistrationNumber: '5567890123', legalName: 'Other AB' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toBeNull()
  })

  it('preserves the TIC `legalEntityType` exactly so mapEntityType can classify v2 strings', async () => {
    // Important: TIC v2 returns full Swedish names like "Aktiebolag" and
    // "Enskild firma" (not the v1 "AB"/"EF" abbreviations). The canonical
    // mapEntityType in lib/company-lookup/entity-type-map.ts handles both
    // sets, but only if we pass the raw string through unchanged.
    const supabase = mockSupabase([
      makeRole({ companyRegistrationNumber: '8001011231', legalEntityType: 'Enskild firma' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '8001011231')

    expect(result?.legalEntityType).toBe('Enskild firma')
  })
})

describe('findCompanyRoleByPick', () => {
  it('resolves the opaque TIC companyId against the user\'s own roles (#58)', async () => {
    const supabase = mockSupabase([
      makeRole({ companyId: 111, companyRegistrationNumber: '5560125790', legalName: 'Acme AB' }),
      makeRole({ companyId: 222, companyRegistrationNumber: '1982010223430001', legalName: 'Firma', legalEntityType: 'Enskild firma' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByPick(supabase as any, 'user-1', '222')

    expect(result).toMatchObject({ companyId: 222, legalName: 'Firma', companyRegistrationNumber: '1982010223430001' })
  })

  it('returns null for an id that is not one of the user\'s roles', async () => {
    const supabase = mockSupabase([makeRole({ companyId: 111 })])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findCompanyRoleByPick(supabase as any, 'user-1', '999')).toBeNull()
  })

  it('refuses a non-numeric pick without reading the roles', async () => {
    const supabase = mockSupabase([makeRole({ companyId: 111 })])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findCompanyRoleByPick(supabase as any, 'user-1', '1982010223430001x')).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

function mockMemberships(
  companies: Array<{ id: string; org_number: string | null; archived_at: string | null }>,
) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({
          data: companies.map((company) => ({ company })),
          error: null,
        }),
      }),
    }),
  }
}

describe('findOwnCompanyByOrgNumber', () => {
  it('finds the sole trader\'s own firm from the 16-digit picker link (crm#68)', async () => {
    const supabase = mockMemberships([
      { id: 'ef-1', org_number: '8201022343', archived_at: null },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findOwnCompanyByOrgNumber(supabase as any, 'user-1', '1982010223430001')

    expect(result).toBe('ef-1')
  })

  it('matches an aktiebolag regardless of formatting', async () => {
    const supabase = mockMemberships([
      { id: 'ab-1', org_number: '556012-5790', archived_at: null },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findOwnCompanyByOrgNumber(supabase as any, 'user-1', '5560125790')).toBe('ab-1')
  })

  it('ignores archived companies so a restarted company can be set up again', async () => {
    const supabase = mockMemberships([
      { id: 'old', org_number: '8201022343', archived_at: '2026-09-01T00:00:00Z' },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findOwnCompanyByOrgNumber(supabase as any, 'user-1', '1982010223430001')).toBeNull()
  })

  it('returns null for a company the user does not have', async () => {
    const supabase = mockMemberships([
      { id: 'ab-1', org_number: '5560125790', archived_at: null },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findOwnCompanyByOrgNumber(supabase as any, 'user-1', '5591715734')).toBeNull()
  })

  it('returns null without querying for a non org-number value', async () => {
    const supabase = mockMemberships([])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await findOwnCompanyByOrgNumber(supabase as any, 'user-1', 'abc')).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
