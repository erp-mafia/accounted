import { describe, it, expect, vi } from 'vitest'
import { findCompanyRoleByOrgNumber } from '../page'
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

    expect(result).toEqual({ legalName: 'Acme AB', legalEntityType: 'Aktiebolag' })
  })

  it('matches orgnrs with hyphens stripped (TIC returns "556012-5790")', async () => {
    // CompanyRoles may carry the orgnr in formatted form; the function under
    // test cleans the registered form before comparing to the cleaned input.
    const supabase = mockSupabase([
      makeRole({ companyRegistrationNumber: '556012-5790', legalName: 'Acme AB' }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findCompanyRoleByOrgNumber(supabase as any, 'user-1', '5560125790')

    expect(result).toEqual({ legalName: 'Acme AB', legalEntityType: 'Aktiebolag' })
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
