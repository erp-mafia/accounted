import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  companyEchoFromContext,
  companyEchoPayload,
  isCompanyDependentTool,
  isOperationScopedTool,
  isScopedTool,
  listAccessibleCompanies,
  parseScopeArgument,
  projectToolInputSchema,
  resolveMcpCompanyContext,
  resolveMcpCompanyScope,
  resolveOperationCompanyId,
} from '../company-routing'

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = '99999999-9999-4999-8999-999999999999'

const getMultiUserStateMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>(
    '@/lib/entitlements/multi-user',
  )
  return {
    ...actual,
    getMultiUserState: (...args: unknown[]) => getMultiUserStateMock(...args),
  }
})

const resolveCompanyScopeMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/portfolio/scope', () => ({
  resolveCompanyScope: (...args: unknown[]) => resolveCompanyScopeMock(...args),
  SCOPE_MAX_COMPANIES: 25,
}))

const getUserCompaniesMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => getUserCompaniesMock(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  getMultiUserStateMock.mockResolvedValue({ state: 'entitled', graceEndsAt: null })
})

function membershipClient(result: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue(result),
  }
  return { client: { from: vi.fn(() => chain) }, chain }
}

describe('scoped and operation-scoped tool classification', () => {
  it('scoped tools are company-independent for the dispatcher and get no company_id property', () => {
    for (const name of [
      'gnubok_client_overview',
      'gnubok_portfolio_readiness',
      'gnubok_run_across_companies',
      'gnubok_stage_across_companies',
    ]) {
      expect(isScopedTool(name)).toBe(true)
      expect(isCompanyDependentTool(name)).toBe(false)
      const projected = projectToolInputSchema({ name, inputSchema: { type: 'object', properties: {} } })
      expect((projected.properties as Record<string, unknown>).company_id).toBeUndefined()
    }
    expect(isScopedTool('gnubok_list_invoices')).toBe(false)
  })

  it('approve and reject are operation-scoped, other tools are not', () => {
    expect(isOperationScopedTool('gnubok_approve_pending_operation')).toBe(true)
    expect(isOperationScopedTool('gnubok_reject_pending_operation')).toBe(true)
    expect(isOperationScopedTool('gnubok_list_pending_operations')).toBe(false)
  })
})

describe('parseScopeArgument', () => {
  it('defaults to an empty input and accepts the documented shapes', () => {
    expect(parseScopeArgument(undefined)).toEqual({})
    expect(parseScopeArgument('all')).toEqual({ companies: 'all' })
    expect(parseScopeArgument('team')).toEqual({ companies: 'team' })
    expect(parseScopeArgument([OTHER_COMPANY_ID])).toEqual({ companies: [OTHER_COMPANY_ID] })
    expect(
      parseScopeArgument({ companies: [OTHER_COMPANY_ID], exclude: [DEFAULT_COMPANY_ID] })
    ).toEqual({ companies: [OTHER_COMPANY_ID], exclude: [DEFAULT_COMPANY_ID] })
    expect(parseScopeArgument({ companies: 'team' })).toEqual({ companies: 'team' })
  })

  it('rejects malformed shapes with VALIDATION_ERROR', () => {
    for (const bad of ['everything', 42, { companies: 'mine' }, { companies: ['not-a-uuid'] }, { exclude: 'x' }]) {
      expect(() => parseScopeArgument(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
    }
  })
})

describe('companyEchoPayload', () => {
  const echo = { company_id: OTHER_COMPANY_ID, name: 'Other AB', is_default: false }

  it('puts the company first in the text payload', () => {
    const payload = companyEchoPayload({ count: 1, rows: [] }, echo)
    expect(Object.keys(payload as object)).toEqual(['company', 'count', 'rows'])
    expect(payload).toEqual({ company: echo, count: 1, rows: [] })
  })

  it('leaves results that already carry a company key, arrays and scalars alone', () => {
    const own = { company: { id: 'x' }, other: 1 }
    expect(companyEchoPayload(own, echo)).toBe(own)
    const list = [1, 2]
    expect(companyEchoPayload(list, echo)).toBe(list)
    expect(companyEchoPayload('text', echo)).toBe('text')
    expect(companyEchoPayload(null, echo)).toBeNull()
  })
})

describe('resolveMcpCompanyContext display name', () => {
  it('prefers the settings display name over companies.name', async () => {
    const { client } = membershipClient({
      data: {
        company_id: OTHER_COMPANY_ID,
        role: 'admin',
        companies: { archived_at: null, name: 'Legal Name AB', company_settings: { company_name: 'Display AB' } },
      },
      error: null,
    })
    const context = await resolveMcpCompanyContext({
      supabase: client as never,
      userId: 'user-1',
      defaultCompanyId: DEFAULT_COMPANY_ID,
      requestedCompanyId: OTHER_COMPANY_ID,
    })
    expect(context).toEqual({
      companyId: OTHER_COMPANY_ID,
      companyName: 'Display AB',
      role: 'admin',
      isDefault: false,
    })
    expect(companyEchoFromContext(context)).toEqual({ company_id: OTHER_COMPANY_ID, name: 'Display AB', is_default: false })
  })

  it('falls back to companies.name, an array-shaped embed, then the id', async () => {
    const arrayShaped = membershipClient({
      data: {
        company_id: OTHER_COMPANY_ID,
        role: 'owner',
        companies: [{ archived_at: null, name: 'Legal Name AB', company_settings: [] }],
      },
      error: null,
    })
    const fromArray = await resolveMcpCompanyContext({
      supabase: arrayShaped.client as never,
      userId: 'user-1',
      defaultCompanyId: OTHER_COMPANY_ID,
      requestedCompanyId: OTHER_COMPANY_ID,
    })
    expect(fromArray.companyName).toBe('Legal Name AB')
    expect(fromArray.isDefault).toBe(true)

    const bare = membershipClient({ data: { company_id: OTHER_COMPANY_ID, role: 'owner' }, error: null })
    const fromBare = await resolveMcpCompanyContext({
      supabase: bare.client as never,
      userId: 'user-1',
      defaultCompanyId: null,
      requestedCompanyId: OTHER_COMPANY_ID,
    })
    expect(fromBare.companyName).toBe(OTHER_COMPANY_ID)
  })
})

describe('resolveOperationCompanyId', () => {
  it('returns the row company for a well-formed id', async () => {
    const { client, chain } = membershipClient({ data: { company_id: OTHER_COMPANY_ID }, error: null })
    await expect(resolveOperationCompanyId(client as never, OPERATION_ID)).resolves.toBe(OTHER_COMPANY_ID)
    expect(client.from).toHaveBeenCalledWith('pending_operations')
    expect(chain.eq).toHaveBeenCalledWith('id', OPERATION_ID)
  })

  it('returns null for a malformed id, an unknown row or a failing lookup', async () => {
    const { client } = membershipClient({ data: null, error: null })
    await expect(resolveOperationCompanyId(client as never, 'nope')).resolves.toBeNull()
    await expect(resolveOperationCompanyId(client as never, undefined)).resolves.toBeNull()
    await expect(resolveOperationCompanyId(client as never, OPERATION_ID)).resolves.toBeNull()
    const throwing = { from: vi.fn(() => { throw new Error('down') }) }
    await expect(resolveOperationCompanyId(throwing as never, OPERATION_ID)).resolves.toBeNull()
  })
})

describe('resolveMcpCompanyScope', () => {
  const scoped = (companyId: string, role: string) => ({
    companyId,
    name: `${role} AB`,
    orgNumber: null,
    entityType: 'AB',
    role,
    teamId: null,
  })

  it('applies the seat gate per non-owner company and keeps owners untouched', async () => {
    resolveCompanyScopeMock.mockResolvedValue({
      companies: [scoped(DEFAULT_COMPANY_ID, 'owner'), scoped(OTHER_COMPANY_ID, 'admin')],
      truncated: false,
      remainingCompanyIds: [],
      unresolved: [],
      team: null,
    })
    getMultiUserStateMock.mockResolvedValue({ state: 'frozen', graceEndsAt: null })

    const scope = await resolveMcpCompanyScope({
      supabase: {} as never,
      userId: 'user-1',
      scope: { companies: 'all' },
    })

    expect(resolveCompanyScopeMock).toHaveBeenCalledWith({}, 'user-1', { companies: 'all' })
    expect(getMultiUserStateMock).toHaveBeenCalledTimes(1)
    expect(getMultiUserStateMock).toHaveBeenCalledWith({}, OTHER_COMPANY_ID)
    expect(scope.companies.map((c) => c.companyId)).toEqual([DEFAULT_COMPANY_ID])
    expect(scope.dormant).toEqual([OTHER_COMPANY_ID])
  })

  it('passes an undefined scope through as an empty input', async () => {
    resolveCompanyScopeMock.mockResolvedValue({
      companies: [],
      truncated: false,
      remainingCompanyIds: [],
      unresolved: [],
      team: null,
    })
    const scope = await resolveMcpCompanyScope({ supabase: {} as never, userId: 'user-1', scope: undefined })
    expect(resolveCompanyScopeMock).toHaveBeenCalledWith({}, 'user-1', {})
    expect(scope.dormant).toEqual([])
  })
})

describe('listAccessibleCompanies', () => {
  it('returns id and display name for non-archived memberships and never throws', async () => {
    getUserCompaniesMock.mockResolvedValue([
      { company_id: DEFAULT_COMPANY_ID, companies: { id: DEFAULT_COMPANY_ID, name: 'Legal AB', archived_at: null } },
      { company_id: OTHER_COMPANY_ID, companies: { id: OTHER_COMPANY_ID, name: 'Gone AB', archived_at: '2026-01-01' } },
    ])
    const rangeMock = vi.fn().mockResolvedValue({
      data: [{ company_id: DEFAULT_COMPANY_ID, company_name: 'Display AB' }],
      error: null,
    })
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ range: rangeMock })) })) })),
      })),
    }
    await expect(listAccessibleCompanies(supabase as never, 'user-1')).resolves.toEqual([
      { company_id: DEFAULT_COMPANY_ID, name: 'Display AB' },
    ])

    getUserCompaniesMock.mockRejectedValue(new Error('down'))
    await expect(listAccessibleCompanies(supabase as never, 'user-1')).resolves.toEqual([])
  })
})
