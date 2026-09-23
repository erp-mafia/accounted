import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserCompanies: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))

import { listUserCompaniesForPicker, resolveCompanySelection } from '../company-picker'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const ARCHIVED = '44444444-4444-4444-8444-444444444444'

/** company_settings chain: resolves to `settingsRows` whatever is chained. */
function supabaseWithSettings(settingsRows: Array<{ company_id: string; company_name: string | null }>) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'order', 'range', 'eq']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: settingsRows, error: null })
  return { from: vi.fn(() => chain) }
}

describe('listUserCompaniesForPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips archived memberships, prefers company_settings names and puts the active company first', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: A, role: 'owner', companies: { id: A, name: 'Alpha AB', archived_at: null } },
      // Embed as an array: PostgREST returns either shape depending on the FK hint.
      { company_id: B, role: 'member', companies: [{ id: B, name: 'Beta AB', archived_at: null }] },
      { company_id: ARCHIVED, role: 'owner', companies: { id: ARCHIVED, name: 'Gone AB', archived_at: '2026-01-01' } },
      { company_id: C, role: 'viewer', companies: { id: C, name: 'Gamma AB', archived_at: null } },
    ])
    const supabase = supabaseWithSettings([{ company_id: B, company_name: 'Beta Konsult AB' }])

    const result = await listUserCompaniesForPicker(supabase as never, 'user-1', { activeCompanyId: B })

    expect(result).toEqual([
      { company_id: B, name: 'Beta Konsult AB', role: 'member' },
      { company_id: A, name: 'Alpha AB', role: 'owner' },
      { company_id: C, name: 'Gamma AB', role: 'viewer' },
    ])
  })

  it('returns an empty list without touching company_settings when there are no live memberships', async () => {
    mocks.getUserCompanies.mockResolvedValue([])
    const supabase = supabaseWithSettings([])
    expect(await listUserCompaniesForPicker(supabase as never, 'user-1')).toEqual([])
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('propagates a membership lookup failure instead of returning an empty list', async () => {
    mocks.getUserCompanies.mockRejectedValue(new Error('boom'))
    const supabase = supabaseWithSettings([])
    await expect(listUserCompaniesForPicker(supabase as never, 'user-1')).rejects.toThrow('boom')
  })
})

describe('resolveCompanySelection', () => {
  const memberships = [
    { company_id: A, name: 'Alpha AB', role: 'owner' },
    { company_id: B, name: 'Beta AB', role: 'owner' },
    { company_id: C, name: 'Gamma AB', role: 'owner' },
  ]

  it('keeping every company selected is unrestricted (null), defaulting to the active company', () => {
    expect(resolveCompanySelection([C, A, B], memberships, B)).toEqual({
      companyIds: null,
      defaultCompanyId: B,
    })
  })

  it('a strict subset is carried in picker order and keeps the active company as default when ticked', () => {
    expect(resolveCompanySelection([C, A], memberships, A)).toEqual({
      companyIds: [A, C],
      defaultCompanyId: A,
    })
  })

  it('hands the default to the first ticked company when the active one is unticked', () => {
    expect(resolveCompanySelection([C, B], memberships, A)).toEqual({
      companyIds: [B, C],
      defaultCompanyId: B,
    })
  })

  it('ignores ids outside the memberships, non-uuid values and duplicates', () => {
    expect(
      resolveCompanySelection(
        ['99999999-9999-4999-8999-999999999999', 'not-a-uuid', 42, A, A.toUpperCase()],
        memberships,
        A,
      ),
    ).toEqual({ companyIds: [A], defaultCompanyId: A })
  })

  it('returns null when nothing valid was ticked', () => {
    expect(resolveCompanySelection([], memberships, A)).toBeNull()
    expect(resolveCompanySelection(['99999999-9999-4999-8999-999999999999'], memberships, A)).toBeNull()
  })
})
