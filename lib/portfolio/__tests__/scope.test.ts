import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  getUserCompanies: vi.fn(),
  getByraMembership: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))

vi.mock('@/lib/clients/fetch-client-overview', () => ({
  getByraMembership: (...args: unknown[]) => mocks.getByraMembership(...args),
}))

import { resolveCompanyScope, SCOPE_MAX_COMPANIES } from '../scope'
import type { SupabaseClient } from '@supabase/supabase-js'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const client = supabase as unknown as SupabaseClient

const USER_ID = 'user-1'
const TEAM_ID = '2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10'
const OTHER_TEAM_ID = '3b8b0f9d-5d3f-4b79-8b2b-5a1a7a4a3b21'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function membership(over: {
  id: string
  name: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  teamId?: string | null
  archived?: boolean
  asArray?: boolean
  entityType?: string | null
}) {
  const company = {
    id: over.id,
    name: over.name,
    org_number: null,
    entity_type: over.entityType === undefined ? 'aktiebolag' : over.entityType,
    archived_at: over.archived ? '2026-01-01T00:00:00Z' : null,
    created_at: '2025-01-01T00:00:00Z',
    team_id: over.teamId === undefined ? TEAM_ID : over.teamId,
  }
  return {
    id: `m-${over.id}`,
    company_id: over.id,
    role: over.role ?? 'member',
    joined_at: '2025-01-01T00:00:00Z',
    companies: over.asArray ? [company] : company,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mocks.getByraMembership.mockResolvedValue(null)
})

describe('resolveCompanyScope', () => {
  it("defaults to 'all': every non-archived membership, display names from settings, sorted by name (sv)", async () => {
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Örebro Bygg AB', role: 'owner' }),
      membership({ id: uuid(2), name: 'Zeta AB', asArray: true }),
      membership({ id: uuid(3), name: 'Archived AB', archived: true }),
      membership({ id: uuid(4), name: 'Frozen Name AB', role: 'viewer', teamId: null }),
    ])
    // company_settings display names: uuid(4) was renamed after onboarding.
    enqueue({ data: [{ company_id: uuid(4), company_name: 'Alfa Redovisning AB' }] })

    const scope = await resolveCompanyScope(client, USER_ID, {})

    expect(mocks.getUserCompanies).toHaveBeenCalledWith(client, USER_ID)
    expect(scope.companies.map((c) => c.name)).toEqual([
      'Alfa Redovisning AB',
      'Zeta AB',
      'Örebro Bygg AB',
    ])
    expect(scope.companies[0]).toEqual({
      companyId: uuid(4),
      name: 'Alfa Redovisning AB',
      orgNumber: null,
      entityType: 'aktiebolag',
      role: 'viewer',
      teamId: null,
    })
    expect(scope.companies[2].role).toBe('owner')
    expect(scope.companies[2].teamId).toBe(TEAM_ID)
    expect(scope.truncated).toBe(false)
    expect(scope.remainingCompanyIds).toEqual([])
    expect(scope.unresolved).toEqual([])
    expect(scope.team).toBeNull()

    // One settings lookup covering every selected id.
    const inCalls = findCalls('company_settings', 'in')
    expect(inCalls).toHaveLength(1)
    expect(inCalls[0][1]).toEqual([uuid(1), uuid(2), uuid(4)])
  })

  it('returns an empty scope without querying settings when the user has no memberships', async () => {
    mocks.getUserCompanies.mockResolvedValue([])

    const scope = await resolveCompanyScope(client, USER_ID, { companies: 'all' })

    expect(scope.companies).toEqual([])
    expect(findCalls('company_settings', 'in')).toHaveLength(0)
  })

  it("'team' keeps the companies on the byrå team and reports the team", async () => {
    mocks.getByraMembership.mockResolvedValue({ teamId: TEAM_ID, teamName: 'Siffra', role: 'admin' })
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Klient A', teamId: TEAM_ID }),
      membership({ id: uuid(2), name: 'Eget bolag', teamId: OTHER_TEAM_ID }),
      membership({ id: uuid(3), name: 'Klient B', teamId: TEAM_ID }),
      membership({ id: uuid(4), name: 'Klient C', teamId: TEAM_ID, archived: true }),
    ])
    enqueue({ data: [] })

    const scope = await resolveCompanyScope(client, USER_ID, { companies: 'team' })

    expect(mocks.getByraMembership).toHaveBeenCalledWith(client, USER_ID)
    expect(scope.team).toEqual({ id: TEAM_ID, name: 'Siffra' })
    expect(scope.companies.map((c) => c.companyId)).toEqual([uuid(1), uuid(3)])
  })

  it("'team' without a byrå team is empty with team null, not an error", async () => {
    mocks.getUserCompanies.mockResolvedValue([membership({ id: uuid(1), name: 'Klient A' })])

    const scope = await resolveCompanyScope(client, USER_ID, { companies: 'team' })

    expect(scope.companies).toEqual([])
    expect(scope.team).toBeNull()
    expect(scope.truncated).toBe(false)
  })

  it("'all' still reports the byrå team when the caller has one", async () => {
    mocks.getByraMembership.mockResolvedValue({ teamId: TEAM_ID, teamName: 'Siffra', role: 'member' })
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Klient A' }),
      membership({ id: uuid(2), name: 'Eget bolag', teamId: OTHER_TEAM_ID }),
    ])
    enqueue({ data: [] })

    const scope = await resolveCompanyScope(client, USER_ID, {})

    expect(scope.team).toEqual({ id: TEAM_ID, name: 'Siffra' })
    expect(scope.companies).toHaveLength(2)
  })

  it('explicit ids keep the given order and list the rest as unresolved', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Alpha' }),
      membership({ id: uuid(2), name: 'Beta' }),
      membership({ id: uuid(3), name: 'Archived', archived: true }),
    ])
    enqueue({ data: [] })

    const scope = await resolveCompanyScope(client, USER_ID, {
      companies: [uuid(2), uuid(9), 'acme', uuid(1), uuid(3), uuid(2)],
    })

    // Given order, not name order; repeats dropped.
    expect(scope.companies.map((c) => c.companyId)).toEqual([uuid(2), uuid(1)])
    // Non-member, malformed and archived ids are reported, never thrown.
    expect(scope.unresolved).toEqual([uuid(9), 'acme', uuid(3)])
  })

  it('exclude removes ids from any selector', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Alpha' }),
      membership({ id: uuid(2), name: 'Beta' }),
      membership({ id: uuid(3), name: 'Gamma' }),
    ])
    enqueue({ data: [] })

    const scope = await resolveCompanyScope(client, USER_ID, { exclude: [uuid(2)] })

    expect(scope.companies.map((c) => c.companyId)).toEqual([uuid(1), uuid(3)])
    const inCalls = findCalls('company_settings', 'in')
    expect(inCalls[0][1]).toEqual([uuid(1), uuid(3)])
  })

  it(`caps at ${SCOPE_MAX_COMPANIES} companies and returns the remaining ids so the caller can continue`, async () => {
    const total = SCOPE_MAX_COMPANIES + 5
    mocks.getUserCompanies.mockResolvedValue(
      Array.from({ length: total }, (_, i) =>
        membership({ id: uuid(i + 1), name: `Bolag ${String(i + 1).padStart(2, '0')}` }),
      ),
    )
    enqueue({ data: [] })

    const scope = await resolveCompanyScope(client, USER_ID, {})

    expect(scope.companies).toHaveLength(SCOPE_MAX_COMPANIES)
    expect(scope.truncated).toBe(true)
    expect(scope.remainingCompanyIds).toEqual([26, 27, 28, 29, 30].map(uuid))
    // A second call with the remaining ids yields exactly those, in order.
    reset()
    enqueue({ data: [] })
    const rest = await resolveCompanyScope(client, USER_ID, { companies: scope.remainingCompanyIds })
    expect(rest.companies.map((c) => c.companyId)).toEqual(scope.remainingCompanyIds)
    expect(rest.truncated).toBe(false)
  })

  it('restrictTo narrows every selector to the key allowlist and reports outsiders as unresolved', async () => {
    mocks.getByraMembership.mockResolvedValue({ teamId: TEAM_ID, teamName: 'Siffra', role: 'admin' })
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Klient A', teamId: TEAM_ID }),
      membership({ id: uuid(2), name: 'Klient B', teamId: TEAM_ID }),
      membership({ id: uuid(3), name: 'Eget bolag', teamId: OTHER_TEAM_ID }),
    ])
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })

    // 'all' keeps only the allowlist (case-insensitive on the ids).
    const all = await resolveCompanyScope(client, USER_ID, { restrictTo: [uuid(2).toUpperCase(), uuid(3)] })
    expect(all.companies.map((c) => c.companyId)).toEqual([uuid(3), uuid(2)])

    // 'team' is intersected too.
    const team = await resolveCompanyScope(client, USER_ID, { companies: 'team', restrictTo: [uuid(2), uuid(3)] })
    expect(team.companies.map((c) => c.companyId)).toEqual([uuid(2)])

    // An explicit member id outside the allowlist is unresolved, like a non-member.
    const explicit = await resolveCompanyScope(client, USER_ID, {
      companies: [uuid(1), uuid(2)],
      restrictTo: [uuid(2), uuid(3)],
    })
    expect(explicit.companies.map((c) => c.companyId)).toEqual([uuid(2)])
    expect(explicit.unresolved).toEqual([uuid(1)])
  })

  it('null restrictTo means no allowlist', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      membership({ id: uuid(1), name: 'Alpha' }),
      membership({ id: uuid(2), name: 'Beta' }),
    ])
    enqueue({ data: [] })
    const scope = await resolveCompanyScope(client, USER_ID, { restrictTo: null })
    expect(scope.companies).toHaveLength(2)
  })

  it('falls back to companies.name when the settings lookup fails', async () => {
    mocks.getUserCompanies.mockResolvedValue([membership({ id: uuid(1), name: 'Alpha AB' })])
    enqueue({ data: null, error: { message: 'boom', code: '57014' } })

    const scope = await resolveCompanyScope(client, USER_ID, {})

    expect(scope.companies.map((c) => c.name)).toEqual(['Alpha AB'])
  })
})
