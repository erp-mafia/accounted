import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import { currentStagingBatchId } from '@/lib/pending-operations/batch-context'
import { eventBus } from '@/lib/events/bus'

const DEFAULT_COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_COMPANY_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_COMPANY_ID = '33333333-3333-4333-8333-333333333333'
const BATCH_ID = '8c1f0000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(),
  fetchPortfolioOverview: vi.fn(),
  commit: vi.fn(),
  getUserCompanies: vi.fn(),
  hasCapability: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/portfolio/scope', () => ({
  resolveCompanyScope: (...args: unknown[]) => mocks.resolveCompanyScope(...args),
  SCOPE_MAX_COMPANIES: 25,
}))
vi.mock('@/lib/portfolio/overview', () => ({
  fetchPortfolioOverview: (...args: unknown[]) => mocks.fetchPortfolioOverview(...args),
  DEADLINE_KIND_FILTERS: ['vat', 'agi', 'f_skatt', 'inkomstdeklaration', 'arsredovisning', 'any'],
}))
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mocks.commit(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getUserCompanies: (...args: unknown[]) => mocks.getUserCompanies(...args),
}))
vi.mock('@/lib/clients/fetch-client-overview', () => ({
  getByraMembership: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: (...args: unknown[]) => mocks.hasCapability(...args) }
})
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'entitled', graceEndsAt: null }) }
})

import { tools } from '../server'

const scoped = (companyId: string, name: string, role = 'owner') => ({
  companyId,
  name,
  orgNumber: null,
  entityType: 'AB',
  role,
  teamId: null,
})

function scopeOf(...companies: Array<ReturnType<typeof scoped>>) {
  return { companies, truncated: false, remainingCompanyIds: [], unresolved: [], team: null }
}

/**
 * A supabase double keyed by table. company_members answers the per-company
 * membership check with the requested company (owner); pending_operations
 * answers whatever `pendingRows` holds; company_settings has no display
 * names.
 */
function supabaseDouble(pendingRows: Array<Record<string, unknown>> = []) {
  const membershipChain: Record<string, ReturnType<typeof vi.fn>> = {}
  let requestedCompany: string | null = null
  Object.assign(membershipChain, {
    select: vi.fn(() => membershipChain),
    eq: vi.fn((column: string, value: string) => {
      if (column === 'company_id') requestedCompany = value
      return membershipChain
    }),
    is: vi.fn(() => membershipChain),
    maybeSingle: vi.fn(async () => ({
      data: requestedCompany
        ? { company_id: requestedCompany, role: 'owner', companies: { archived_at: null, name: `Company ${requestedCompany.slice(0, 2)}` } }
        : null,
      error: null,
    })),
  })
  const pendingChain: Record<string, ReturnType<typeof vi.fn>> = {}
  const pendingResult = { data: pendingRows, error: null, count: pendingRows.length }
  Object.assign(pendingChain, {
    select: vi.fn(() => pendingChain),
    eq: vi.fn(() => pendingChain),
    in: vi.fn(() => pendingChain),
    order: vi.fn(() => pendingChain),
    range: vi.fn(async () => pendingResult),
    limit: vi.fn(() => pendingChain),
    maybeSingle: vi.fn(async () => ({ data: pendingRows[0] ?? null, error: null })),
    single: vi.fn(async () => ({ data: pendingRows[0] ?? null, error: pendingRows[0] ? null : { message: 'none' } })),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(pendingResult).then(resolve),
  })
  const settingsChain = {
    select: vi.fn(() => ({ in: vi.fn(() => ({ order: vi.fn(() => ({ range: vi.fn().mockResolvedValue({ data: [], error: null }) })) })) })),
  }
  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'company_members') return membershipChain
      if (table === 'pending_operations') return pendingChain
      if (table === 'company_settings') return settingsChain
      throw new Error(`Unexpected table: ${table}`)
    }),
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'a@b.se' } } }) } },
  }
  return { supabase, membershipChain, pendingChain }
}

const overviewTool = tools.find((t) => t.name === 'gnubok_client_overview')!
const runTool = tools.find((t) => t.name === 'gnubok_run_across_companies')!
const stageTool = tools.find((t) => t.name === 'gnubok_stage_across_companies')!
const readinessTool = tools.find((t) => t.name === 'gnubok_portfolio_readiness')!
const approveTool = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!
const listPendingTool = tools.find((t) => t.name === 'gnubok_list_pending_operations')!
const stagedSchema = tools.find((t) => t.name === 'gnubok_ignore_transaction')!.outputSchema

// Fake inner tools registered for the duration of this file: one read, one
// staged write, one write without staging contract.
const fakeRead = {
  name: 'gnubok_fake_read',
  description: 'test read',
  inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'number' } } },
  outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execute: vi.fn(),
}
const fakeStaged = {
  name: 'gnubok_fake_staged',
  description: 'test staged write',
  inputSchema: { type: 'object', additionalProperties: false, properties: { note: { type: 'string' }, dry_run: { type: 'boolean' } } },
  outputSchema: stagedSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  execute: vi.fn(),
}
tools.push(fakeRead as never, fakeStaged as never)

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.hasCapability.mockResolvedValue(true)
  fakeRead.execute.mockImplementation(async (_args: unknown, companyId: string) => ({
    rows: [{ id: `${companyId.slice(0, 2)}-1` }, { id: `${companyId.slice(0, 2)}-2` }],
    count: 2,
  }))
  fakeStaged.execute.mockImplementation(async (args: Record<string, unknown>, companyId: string) => ({
    staged: args.dry_run !== true,
    ...(args.dry_run === true ? { dry_run: true } : { operation_id: `op-${companyId.slice(0, 2)}` }),
    risk_level: 'low',
    message: 'staged',
    preview: { note: args.note, batch: currentStagingBatchId() },
  }))
})

describe('registration', () => {
  it('the four cross-company tools exist with the expected scopes and visibility', () => {
    expect(TOOL_SCOPE_MAP.gnubok_client_overview).toBe('companies:read')
    expect(TOOL_SCOPE_MAP.gnubok_run_across_companies).toBe('companies:read')
    expect(TOOL_SCOPE_MAP.gnubok_stage_across_companies).toBe('companies:read')
    expect(TOOL_SCOPE_MAP.gnubok_portfolio_readiness).toBe('reports:read')
    expect(overviewTool.annotations.readOnlyHint).toBe(true)
    expect(runTool.annotations.readOnlyHint).toBe(true)
    expect(stageTool.annotations.readOnlyHint).toBe(false)
    expect(stageTool.catalogVisibility).toBe('search')
    expect(readinessTool.catalogVisibility).toBe('search')
  })
})

describe('gnubok_client_overview', () => {
  it('resolves the scope, applies the filters and returns wire rows', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    mocks.fetchPortfolioOverview.mockResolvedValue({
      team: null,
      summary: { companies: 1, matched: 1, unbooked_total: 3, inbox_total: 0, overdue: 0, action_needed: 1 },
      companies: [
        {
          companyId: DEFAULT_COMPANY_ID,
          name: 'Default AB',
          orgNumber: '559000-0001',
          entityType: 'AB',
          role: 'owner',
          teamId: null,
          unbookedCount: 3,
          inboxCount: 0,
          nextDeadline: { title: 'Moms', dueDate: '2026-10-12', taxDeadlineType: 'moms_quarterly', urgency: 'action_needed' },
          lastBookedDate: '2026-09-01',
        },
      ],
    })

    const result = (await overviewTool.execute(
      { scope: { companies: 'all' }, deadline_kind: 'vat', deadline_within_days: 30, min_unbooked: 1 },
      '',
      'user-1',
      {} as never,
      { type: 'api_key' }
    )) as Record<string, unknown>

    expect(mocks.resolveCompanyScope).toHaveBeenCalledWith({}, 'user-1', { companies: 'all' })
    expect(mocks.fetchPortfolioOverview).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ dormant: [] }),
      { deadlineKind: 'vat', deadlineWithinDays: 30, minUnbooked: 1 }
    )
    expect(result.companies).toEqual([
      {
        company_id: DEFAULT_COMPANY_ID,
        name: 'Default AB',
        org_number: '559000-0001',
        entity_type: 'AB',
        role: 'owner',
        team_id: null,
        unbooked_count: 3,
        inbox_count: 0,
        next_deadline: { title: 'Moms', due_date: '2026-10-12', tax_deadline_type: 'moms_quarterly', urgency: 'action_needed' },
        last_booked_date: '2026-09-01',
      },
    ])
    expect(result.scope).toEqual({ resolved: 1, truncated: false, remaining_company_ids: [], unresolved: [], dormant: [], team: null })
  })

  it('rejects a malformed scope before touching the database', async () => {
    await expect(
      overviewTool.execute({ scope: { companies: 'mine' } }, '', 'user-1', {} as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mocks.resolveCompanyScope).not.toHaveBeenCalled()
  })
})

describe('gnubok_run_across_companies', () => {
  it('runs the inner read tool once per company and summarises', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(
      scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB'), scoped(OTHER_COMPANY_ID, 'Other AB'))
    )
    const { supabase } = supabaseDouble()

    const result = (await runTool.execute(
      { tool: 'accounted_fake_read', arguments: { limit: 5 }, scope: 'all', __keyScopes: ['companies:read'] },
      '',
      'user-1',
      supabase as never,
      { type: 'api_key', id: 'key-1' }
    )) as {
      tool: string
      results: Array<{ company: { id: string; name: string }; ok: boolean; data?: Record<string, unknown> }>
      succeeded: number
      failed: number
      truncated: boolean
    }

    expect(fakeRead.execute).toHaveBeenCalledTimes(2)
    expect(fakeRead.execute).toHaveBeenCalledWith({ limit: 5 }, DEFAULT_COMPANY_ID, 'user-1', supabase, { type: 'api_key', id: 'key-1' })
    expect(result.tool).toBe('gnubok_fake_read')
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.results.map((r) => r.company)).toEqual([
      { company_id: DEFAULT_COMPANY_ID, name: 'Default AB' },
      { company_id: OTHER_COMPANY_ID, name: 'Other AB' },
    ])
    expect(result.results[0].data).toEqual({ rows: [{ id: '11-1' }, { id: '11-2' }], rows_count: 2, count: 2 })
  })

  it('isolates a failing company and keeps the others', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(
      scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB'), scoped(OTHER_COMPANY_ID, 'Other AB'))
    )
    fakeRead.execute.mockImplementation(async (_args: unknown, companyId: string) => {
      if (companyId === OTHER_COMPANY_ID) throw Object.assign(new Error('Perioden är låst'), { code: 'PERIOD_LOCKED' })
      return { ok: true }
    })
    const { supabase } = supabaseDouble()
    const result = (await runTool.execute(
      { tool: 'gnubok_fake_read', scope: { companies: 'all' } },
      '',
      'user-1',
      supabase as never
    )) as { results: Array<{ ok: boolean; error?: { code: string } }>; failed: number }
    expect(result.failed).toBe(1)
    expect(result.results[1].ok).toBe(false)
    expect(result.results[1].error?.code).toBe('PERIOD_LOCKED')
  })

  it('refuses write tools, unknown tools, company_id in arguments and unknown parameters', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    const { supabase } = supabaseDouble()
    await expect(runTool.execute({ tool: 'gnubok_fake_staged' }, '', 'user-1', supabase as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(runTool.execute({ tool: 'gnubok_nope' }, '', 'user-1', supabase as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      runTool.execute({ tool: 'gnubok_fake_read', arguments: { company_id: OTHER_COMPANY_ID } }, '', 'user-1', supabase as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      runTool.execute({ tool: 'gnubok_fake_read', arguments: { limti: 5 } }, '', 'user-1', supabase as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(runTool.execute({ tool: 'gnubok_list_companies' }, '', 'user-1', supabase as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fakeRead.execute).not.toHaveBeenCalled()
  })

  it('checks the inner tool scope against the key scopes', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    const { supabase } = supabaseDouble()
    await expect(
      runTool.execute(
        { tool: 'gnubok_list_invoices', __keyScopes: ['companies:read'] },
        '',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/Insufficient scope/)
  })

  it('gates each company on the inner tool capability', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    mocks.hasCapability.mockResolvedValue(false)
    // Any read tool the paywall map gates; skip if the map has none.
    const gated = tools.find(
      (t) => t.annotations.readOnlyHint === true && MCP_TOOL_CAPABILITY_MAP[t.name] !== undefined
    )
    if (!gated) return
    const { supabase } = supabaseDouble()
    const result = (await runTool.execute(
      { tool: gated.name, arguments: {} },
      '',
      'user-1',
      supabase as never
    )) as { results: Array<{ ok: boolean; error?: { code: string } }> }
    expect(result.results[0].ok).toBe(false)
    expect(mocks.hasCapability).toHaveBeenCalledWith(supabase, DEFAULT_COMPANY_ID, MCP_TOOL_CAPABILITY_MAP[gated.name])
  })
})

describe('gnubok_stage_across_companies', () => {
  it('stages once per company under one batch id, sequentially, with per-company overrides', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(
      scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB'), scoped(OTHER_COMPANY_ID, 'Other AB', 'admin'))
    )
    const { supabase, membershipChain } = supabaseDouble()

    const result = (await stageTool.execute(
      {
        tool: 'gnubok_fake_staged',
        arguments: { note: 'shared' },
        per_company_arguments: { [OTHER_COMPANY_ID]: { note: 'override' } },
        scope: { companies: 'all' },
        __keyScopes: ['companies:read'],
      },
      '',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      batch_id: string
      staged_count: number
      results: Array<{ company: { company_id: string }; ok: boolean; operation_id?: string; preview?: { note: string; batch: string } }>
    }

    expect(result.batch_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.staged_count).toBe(2)
    expect(result.results.map((r) => r.company.company_id)).toEqual([DEFAULT_COMPANY_ID, OTHER_COMPANY_ID])
    expect(fakeStaged.execute).toHaveBeenNthCalledWith(1, { note: 'shared' }, DEFAULT_COMPANY_ID, 'user-1', supabase, { type: 'api_key' })
    expect(fakeStaged.execute).toHaveBeenNthCalledWith(2, { note: 'override' }, OTHER_COMPANY_ID, 'user-1', supabase, { type: 'api_key' })
    // Membership was re-checked per company (write path).
    expect(membershipChain.eq).toHaveBeenCalledWith('company_id', DEFAULT_COMPANY_ID)
    expect(membershipChain.eq).toHaveBeenCalledWith('company_id', OTHER_COMPANY_ID)
    // The staging helper saw the batch id through the async context.
    expect(result.results.map((r) => r.preview?.batch)).toEqual([result.batch_id, result.batch_id])
    expect(result.results.map((r) => r.operation_id)).toEqual(['op-11', 'op-22'])
  })

  it('refuses high-risk tools, non-staging tools, unresolved ids and dry_run on tools without it', async () => {
    const { supabase } = supabaseDouble()
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    await expect(stageTool.execute({ tool: 'gnubok_run_year_end' }, '', 'user-1', supabase as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(stageTool.execute({ tool: 'gnubok_fake_read' }, '', 'user-1', supabase as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fakeStaged.execute).not.toHaveBeenCalled()

    mocks.resolveCompanyScope.mockResolvedValue({ ...scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')), unresolved: [STRANGER_COMPANY_ID] })
    await expect(
      stageTool.execute({ tool: 'gnubok_fake_staged', scope: [DEFAULT_COMPANY_ID, STRANGER_COMPANY_ID] }, '', 'user-1', supabase as never)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fakeStaged.execute).not.toHaveBeenCalled()

    // A staging tool that has no dry_run parameter (whichever ships one).
    const noDryRun = tools.find(
      (t) =>
        t.outputSchema === stagedSchema &&
        !('dry_run' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) &&
        t.name !== 'gnubok_fake_staged'
    )
    if (noDryRun) {
      mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
      await expect(
        stageTool.execute({ tool: noDryRun.name, dry_run: true }, '', 'user-1', supabase as never)
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })

  it('dry_run forwards to every company and stages nothing', async () => {
    mocks.resolveCompanyScope.mockResolvedValue(scopeOf(scoped(DEFAULT_COMPANY_ID, 'Default AB')))
    const { supabase } = supabaseDouble()
    const result = (await stageTool.execute(
      { tool: 'gnubok_fake_staged', arguments: { note: 'x' }, dry_run: true },
      '',
      'user-1',
      supabase as never
    )) as { batch_id: string | null; staged_count: number; dry_run: boolean }
    expect(result).toMatchObject({ batch_id: null, staged_count: 0, dry_run: true })
    // No actor given: the tool runs the inner call as a plain api_key actor.
    expect(fakeStaged.execute).toHaveBeenCalledWith({ note: 'x', dry_run: true }, DEFAULT_COMPANY_ID, 'user-1', supabase, { type: 'api_key' })
  })
})

describe('gnubok_approve_pending_operation with batch_id', () => {
  it('commits low and medium risk members in their own companies and skips high risk', async () => {
    const members = [
      { id: 'op-1', company_id: DEFAULT_COMPANY_ID, operation_type: 'ignore_transaction', risk_level: 'low', status: 'pending', batch_id: BATCH_ID },
      { id: 'op-2', company_id: OTHER_COMPANY_ID, operation_type: 'categorize_transaction', risk_level: 'medium', status: 'pending', batch_id: BATCH_ID },
      { id: 'op-3', company_id: OTHER_COMPANY_ID, operation_type: 'create_voucher', risk_level: 'high', status: 'pending', batch_id: BATCH_ID },
    ]
    const { supabase, pendingChain } = supabaseDouble(members)
    mocks.commit.mockResolvedValue({ status: 'committed', data: { ok: true } })

    const result = (await approveTool.execute(
      { batch_id: BATCH_ID },
      DEFAULT_COMPANY_ID,
      'user-1',
      supabase as never,
      { type: 'api_key', id: 'key-1', unattendedCommitLimit: null }
    )) as { status: string; committed: number; skipped: number; failed: number; results: Array<Record<string, unknown>> }

    expect(pendingChain.eq).toHaveBeenCalledWith('batch_id', BATCH_ID)
    expect(pendingChain.eq).toHaveBeenCalledWith('status', 'pending')
    expect(result.status).toBe('batch')
    expect(result.committed).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(mocks.commit).toHaveBeenCalledTimes(2)
    expect(mocks.commit).toHaveBeenNthCalledWith(1, supabase, 'user-1', DEFAULT_COMPANY_ID, members[0], expect.objectContaining({ commitMethod: 'api_key' }))
    expect(mocks.commit).toHaveBeenNthCalledWith(2, supabase, 'user-1', OTHER_COMPANY_ID, members[1], expect.objectContaining({ commitMethod: 'api_key' }))
    expect(result.results[2]).toMatchObject({ operation_id: 'op-3', status: 'skipped', reason: 'high_risk_requires_individual_approval' })
  })

  it('requires exactly one of operation_id and batch_id', async () => {
    const { supabase } = supabaseDouble()
    await expect(approveTool.execute({}, DEFAULT_COMPANY_ID, 'user-1', supabase as never)).rejects.toThrow(/operation_id or batch_id/)
    await expect(
      approveTool.execute({ operation_id: 'x', batch_id: BATCH_ID }, DEFAULT_COMPANY_ID, 'user-1', supabase as never)
    ).rejects.toThrow(/not both/)
  })
})

describe('gnubok_list_pending_operations across companies', () => {
  it('all_companies lists within the memberships and names each company', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: DEFAULT_COMPANY_ID, companies: { id: DEFAULT_COMPANY_ID, name: 'Default AB', archived_at: null } },
      { company_id: OTHER_COMPANY_ID, companies: { id: OTHER_COMPANY_ID, name: 'Other AB', archived_at: null } },
    ])
    const rows = [
      { id: 'op-1', company_id: OTHER_COMPANY_ID, operation_type: 'ignore_transaction', status: 'pending', risk_level: 'low', created_at: '2026-09-01' },
    ]
    const { supabase, pendingChain } = supabaseDouble(rows)

    const result = (await listPendingTool.execute({ all_companies: true }, DEFAULT_COMPANY_ID, 'user-1', supabase as never)) as {
      operations: Array<{ id: string; company_name: string | null }>
    }
    expect(pendingChain.in).toHaveBeenCalledWith('company_id', [DEFAULT_COMPANY_ID, OTHER_COMPANY_ID])
    expect(pendingChain.eq).not.toHaveBeenCalledWith('company_id', DEFAULT_COMPANY_ID)
    expect(result.operations[0]).toMatchObject({ id: 'op-1', company_name: 'Other AB' })
  })

  it('batch_id filters the batch across companies', async () => {
    mocks.getUserCompanies.mockResolvedValue([
      { company_id: DEFAULT_COMPANY_ID, companies: { id: DEFAULT_COMPANY_ID, name: 'Default AB', archived_at: null } },
    ])
    const { supabase, pendingChain } = supabaseDouble([])
    await listPendingTool.execute({ batch_id: BATCH_ID }, DEFAULT_COMPANY_ID, 'user-1', supabase as never)
    expect(pendingChain.eq).toHaveBeenCalledWith('batch_id', BATCH_ID)
    expect(pendingChain.in).toHaveBeenCalledWith('company_id', [DEFAULT_COMPANY_ID])
  })
})
