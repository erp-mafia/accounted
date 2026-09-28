/**
 * GET /api/v1/portfolio/overview: the cross-company overview on the v1 door.
 *
 * Static route (no `{companyId}`), so Next.js 16 invokes the handler with
 * `{ params: undefined }` (regression #781): every test uses that exact
 * shape. The scope resolver and the overview are mocked; what is under test
 * is auth, scope enforcement, query validation and the snake_case wire shape.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const mocks = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(),
  fetchPortfolioOverview: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

vi.mock('@/lib/portfolio/scope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/portfolio/scope')>('@/lib/portfolio/scope')
  return {
    ...actual,
    resolveCompanyScope: (...args: unknown[]) => mocks.resolveCompanyScope(...args),
  }
})

vi.mock('@/lib/portfolio/overview', async () => {
  const actual = await vi.importActual<typeof import('@/lib/portfolio/overview')>('@/lib/portfolio/overview')
  return {
    ...actual,
    fetchPortfolioOverview: (...args: unknown[]) => mocks.fetchPortfolioOverview(...args),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { ResolvedCompanyScope } from '@/lib/portfolio/scope'
import type { PortfolioOverview } from '@/lib/portfolio/overview'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const USER_ID = '930abb54-c5ef-4ae0-b274-30fb16e9a295'
const COMPANY_A = '8fd5b1f4-0000-4000-8000-000000000001'
const COMPANY_B = '8fd5b1f4-0000-4000-8000-000000000002'
const COMPANY_C = '8fd5b1f4-0000-4000-8000-000000000003'
const TEAM_ID = '2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10'

const supabase = { from: vi.fn() }

function makeRequest(query: Record<string, string> = {}, withAuth = true): Request {
  const url = new URL('https://x.test/api/v1/portfolio/overview')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return new Request(url, {
    headers: withAuth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

type GetCtx = Parameters<typeof GET>[1]
const staticRouteContext = () => ({ params: undefined } as unknown as GetCtx)

const scope: ResolvedCompanyScope = {
  companies: [
    {
      companyId: COMPANY_A,
      name: 'Acme AB',
      orgNumber: '556677-8899',
      entityType: 'aktiebolag',
      role: 'member',
      teamId: TEAM_ID,
    },
  ],
  truncated: true,
  remainingCompanyIds: [COMPANY_C],
  unresolved: [COMPANY_B],
  team: { id: TEAM_ID, name: 'Siffra' },
}

const overview: PortfolioOverview = {
  team: { id: TEAM_ID, name: 'Siffra' },
  summary: { companies: 1, matched: 1, unbooked_total: 11, inbox_total: 3, overdue: 1, action_needed: 0 },
  companies: [
    {
      companyId: COMPANY_A,
      name: 'Acme AB',
      orgNumber: '556677-8899',
      entityType: 'aktiebolag',
      role: 'member',
      teamId: TEAM_ID,
      unbookedCount: 11,
      inboxCount: 3,
      nextDeadline: {
        title: 'Momsdeklaration',
        dueDate: '2026-09-12',
        taxDeadlineType: 'moms_quarterly',
        urgency: 'overdue',
      },
      lastBookedDate: '2026-08-28',
      deadlines: [
        {
          title: 'Momsdeklaration',
          dueDate: '2026-09-12',
          taxDeadlineType: 'moms_quarterly',
          urgency: 'overdue',
        },
      ],
    },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: null,
    apiKeyId: 'ak_1',
    apiKeyName: 'Byrå key',
    scopes: ['companies:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(supabase)
  mocks.resolveCompanyScope.mockResolvedValue(scope)
  mocks.fetchPortfolioOverview.mockResolvedValue(overview)
})

describe('GET /api/v1/portfolio/overview', () => {
  it('returns 401 when the key does not validate', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(401)
    expect(mocks.resolveCompanyScope).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing bearer token', async () => {
    const res = await GET(makeRequest({}, false), staticRouteContext())
    expect(res.status).toBe(401)
  })

  it('returns 403 without companies:read', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: null,
      apiKeyId: 'ak_1',
      apiKeyName: 'Invoices key',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(mocks.resolveCompanyScope).not.toHaveBeenCalled()
  })

  it.each([['0'], ['366'], ['abc'], ['7.5']])(
    'returns 400 for deadline_within_days=%s',
    async (value) => {
      const res = await GET(makeRequest({ deadline_within_days: value }), staticRouteContext())
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(body.error.details.issues[0].field).toBe('deadline_within_days')
      expect(mocks.resolveCompanyScope).not.toHaveBeenCalled()
    },
  )

  it('returns 400 for an unknown deadline_kind, a negative min_unbooked and a bad team flag', async () => {
    const bad: Record<string, string>[] = [{ deadline_kind: 'moms' }, { min_unbooked: '-1' }, { team: 'yes' }]
    for (const query of bad) {
      const res = await GET(makeRequest(query), staticRouteContext())
      expect(res.status, JSON.stringify(query)).toBe(400)
    }
  })

  it('returns 400 for a malformed company id in companies or exclude, naming the field', async () => {
    const res = await GET(makeRequest({ companies: `${COMPANY_A},acme` }), staticRouteContext())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues).toEqual([
      { field: 'companies', message: expect.stringContaining('acme') },
    ])

    const res2 = await GET(makeRequest({ exclude: 'nope' }), staticRouteContext())
    expect(res2.status).toBe(400)
    const body2 = await res2.json()
    expect(body2.error.details.issues[0].field).toBe('exclude')
  })

  it('returns 400 when team=true is combined with an explicit companies list', async () => {
    const res = await GET(makeRequest({ team: 'true', companies: COMPANY_A }), staticRouteContext())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues[0].field).toBe('team')
  })

  it('resolves the default scope (all) with no filters and serializes the overview in snake_case', async () => {
    const res = await GET(makeRequest(), staticRouteContext())
    expect(res.status).toBe(200)

    expect(mocks.resolveCompanyScope).toHaveBeenCalledWith(supabase, USER_ID, { companies: 'all' })
    expect(mocks.fetchPortfolioOverview).toHaveBeenCalledWith(supabase, scope, {})

    const body = await res.json()
    expect(body.meta.request_id).toMatch(/^req_/)
    expect(body.data).toEqual({
      team: { id: TEAM_ID, name: 'Siffra' },
      scope: { truncated: true, remaining_company_ids: [COMPANY_C], unresolved: [COMPANY_B] },
      summary: { companies: 1, matched: 1, unbooked_total: 11, inbox_total: 3, overdue: 1, action_needed: 0 },
      companies: [
        {
          company_id: COMPANY_A,
          name: 'Acme AB',
          org_number: '556677-8899',
          entity_type: 'aktiebolag',
          role: 'member',
          team_id: TEAM_ID,
          unbooked_count: 11,
          inbox_count: 3,
          next_deadline: {
            title: 'Momsdeklaration',
            due_date: '2026-09-12',
            tax_deadline_type: 'moms_quarterly',
            urgency: 'overdue',
          },
          last_booked_date: '2026-08-28',
          deadlines: [
            {
              title: 'Momsdeklaration',
              due_date: '2026-09-12',
              tax_deadline_type: 'moms_quarterly',
              urgency: 'overdue',
            },
          ],
        },
      ],
    })
  })

  it('passes an explicit companies list (in order), exclude and every filter through', async () => {
    const res = await GET(
      makeRequest({
        companies: ` ${COMPANY_B}, ${COMPANY_A},,`,
        exclude: COMPANY_C,
        deadline_kind: 'vat',
        deadline_within_days: '7',
        min_unbooked: '5',
        min_inbox: '1',
      }),
      staticRouteContext(),
    )
    expect(res.status).toBe(200)
    expect(mocks.resolveCompanyScope).toHaveBeenCalledWith(supabase, USER_ID, {
      companies: [COMPANY_B, COMPANY_A],
      exclude: [COMPANY_C],
    })
    expect(mocks.fetchPortfolioOverview).toHaveBeenCalledWith(supabase, scope, {
      deadlineKind: 'vat',
      deadlineWithinDays: 7,
      minUnbooked: 5,
      minInbox: 1,
    })
  })

  it('passes the key company allowlist to the resolver as restrictTo', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_A,
      apiKeyId: 'ak_1',
      apiKeyName: 'Restricted key',
      scopes: ['companies:read'],
      mode: 'live',
      allowedCompanyIds: [COMPANY_A, COMPANY_B],
    })
    const res = await GET(makeRequest({ team: 'true' }), staticRouteContext())
    expect(res.status).toBe(200)
    expect(mocks.resolveCompanyScope).toHaveBeenCalledWith(supabase, USER_ID, {
      companies: 'team',
      restrictTo: [COMPANY_A, COMPANY_B],
    })
  })

  it('team=true selects the byrå team scope', async () => {
    const res = await GET(makeRequest({ team: 'true' }), staticRouteContext())
    expect(res.status).toBe(200)
    expect(mocks.resolveCompanyScope).toHaveBeenCalledWith(supabase, USER_ID, { companies: 'team' })
  })

  it('serializes an empty scope with null team and no rows', async () => {
    mocks.resolveCompanyScope.mockResolvedValue({
      companies: [],
      truncated: false,
      remainingCompanyIds: [],
      unresolved: [],
      team: null,
    })
    mocks.fetchPortfolioOverview.mockResolvedValue({
      team: null,
      summary: { companies: 0, matched: 0, unbooked_total: 0, inbox_total: 0, overdue: 0, action_needed: 0 },
      companies: [],
    })
    const res = await GET(makeRequest({ team: 'true' }), staticRouteContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.team).toBeNull()
    expect(body.data.companies).toEqual([])
    expect(body.data.scope).toEqual({ truncated: false, remaining_company_ids: [], unresolved: [] })
  })
})
