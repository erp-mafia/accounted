import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadUserDirectorship } from '../inputs'

// The composer can only put "Du driver…" in the user's mouth when we have
// evidence the user actually directs this company. The signal: BankID
// CompanyRoles for the active user, matched against this company's orgnr,
// with a director-like positionType still active. These tests pin every
// branch — false positives here means we'd narrate ownership for an
// accountant or employee, which is the exact UX bug we just fixed.

function buildSupabase(opts: {
  companyOrgNumber?: string | null
  enrichment?: unknown
}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'maybeSingle', 'single']
      for (const m of methods) {
        chain[m] = () => {
          if (m === 'single' && table === 'companies') {
            return Promise.resolve({
              data: { org_number: opts.companyOrgNumber ?? null },
              error: null,
            })
          }
          if (m === 'maybeSingle' && table === 'bankid_enrichment') {
            return Promise.resolve({
              data: opts.enrichment ?? null,
              error: null,
            })
          }
          return chain
        }
      }
      return chain
    }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadUserDirectorship', () => {
  it('returns confirmedDirector=true when user has a boardMember position at this orgnr', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '5560125790',
            positionTypes: ['boardMember'],
            positionEnd: null,
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(true)
  })

  it('returns confirmedDirector=true for ceo role', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '5560125790',
            positionTypes: ['ceo'],
            positionEnd: null,
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(true)
  })

  it('matches even when orgnr is hyphen-formatted in CompanyRoles', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '556012-5790',
            positionTypes: ['chairman'],
            positionEnd: null,
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(true)
  })

  it('returns confirmedDirector=false when company has no org_number (manual-name signup)', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: null,
      enrichment: { company_roles: [] },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(false)
  })

  it('returns confirmedDirector=false when user has no BankID enrichment (email signup)', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: null,
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(false)
  })

  it('returns confirmedDirector=false when CompanyRoles has no match for this orgnr', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '5567890123', // different company
            positionTypes: ['ceo'],
            positionEnd: null,
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(false)
  })

  it('returns confirmedDirector=false when position has already ended', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '5560125790',
            positionTypes: ['boardMember'],
            // 1 year ago
            positionEnd: new Date(Date.now() - 365 * 24 * 3600_000).toISOString(),
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(false)
  })

  it('returns confirmedDirector=false for non-director positions (deputyBoardMember, auditor)', async () => {
    const supabase = buildSupabase({
      companyOrgNumber: '5560125790',
      enrichment: {
        company_roles: [
          {
            companyRegistrationNumber: '5560125790',
            positionTypes: ['deputyBoardMember', 'auditor'],
            positionEnd: null,
          },
        ],
      },
    })

    const result = await loadUserDirectorship(supabase, 'co-1')
    expect(result.confirmedDirector).toBe(false)
  })
})
