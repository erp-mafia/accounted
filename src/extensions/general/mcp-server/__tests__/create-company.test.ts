import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'

const mocks = vi.hoisted(() => ({
  createCompanyCore: vi.fn(),
}))

vi.mock('@/lib/company/create-company', () => ({
  createCompanyCore: (...args: unknown[]) => mocks.createCompanyCore(...args),
}))

import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { isCompanyDependentTool } from '../company-routing'

const tool = tools.find((t) => t.name === 'gnubok_create_company')!
const TEAM_ID = '44444444-4444-4444-8444-444444444444'
const COMPANY_ID = '55555555-5555-4555-8555-555555555555'

function supabaseWithTeam(teamId: string | null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: teamId ? { team_id: teamId } : null, error: null }),
  }
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn().mockResolvedValue({ data: COMPANY_ID, error: null }),
    chain,
  }
}

const setup = {
  name: 'Testbolaget AB',
  entity_type: 'aktiebolag',
  org_number: '556000-0001',
  vat_registered: true,
  moms_period: 'quarterly',
  accounting_method: 'accrual',
  f_skatt: true,
}

describe('gnubok_create_company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('is a companies:write, company-independent write tool', () => {
    expect(tool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_create_company).toBe('companies:write')
    expect(isCompanyDependentTool('gnubok_create_company')).toBe(false)
    expect(tool.annotations.readOnlyHint).toBe(false)
    expect(tool.annotations.destructiveHint).toBe(false)
  })

  it('defaults an omitted accounting_method by form and flags it in the preview', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    const { accounting_method: _dropped, ...withoutMethod } = setup
    const result = (await tool.execute(withoutMethod, '', 'user-1', supabase as never)) as Record<string, unknown>

    expect(result.created).toBe(false)
    const preview = result.preview as Record<string, unknown>
    expect(preview.accounting_method).toBe('accrual')
    expect(preview.accounting_method_defaulted).toBe(true)
  })

  it('does not flag an explicitly chosen accounting_method as defaulted', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    const result = (await tool.execute(setup, '', 'user-1', supabase as never)) as Record<string, unknown>
    const preview = result.preview as Record<string, unknown>
    expect(preview.accounting_method).toBe('accrual')
    expect('accounting_method_defaulted' in preview).toBe(false)
  })

  it('previews without creating when confirm is not true', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    const result = (await tool.execute(setup, '', 'user-1', supabase as never)) as Record<string, unknown>

    expect(result.created).toBe(false)
    expect(result.requires_confirmation).toBe(true)
    const preview = result.preview as Record<string, unknown>
    expect(preview.org_number).toBe('5560000001')
    expect(preview.vat_number).toBe('SE556000000101')
    expect(preview.team_id).toBe(TEAM_ID)
    expect(preview.fiscal_period).toMatchObject({ name: expect.stringContaining('Räkenskapsår') })
    expect(mocks.createCompanyCore).not.toHaveBeenCalled()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('creates through the service-role RPC for the key user with confirm=true', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    mocks.createCompanyCore.mockImplementation(
      async (_client: unknown, _input: unknown, createRow: () => Promise<{ data: unknown; error: unknown }>) => {
        const { data } = await createRow()
        return { companyId: data as string }
      }
    )

    const result = (await tool.execute(
      { ...setup, confirm: true },
      '',
      'user-1',
      supabase as never
    )) as Record<string, unknown>

    expect(result.created).toBe(true)
    expect(result.company_id).toBe(COMPANY_ID)
    expect(supabase.rpc).toHaveBeenCalledWith('create_company_for_user', {
      p_user_id: 'user-1',
      p_name: 'Testbolaget AB',
      p_entity_type: 'aktiebolag',
      p_team_id: TEAM_ID,
    })
    const [, input] = mocks.createCompanyCore.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(input.settings).toMatchObject({ moms_period: 'quarterly', vat_registered: true, company_name: 'Testbolaget AB' })
    expect((result.next as Record<string, unknown>).tool).toBe('gnubok_load_skill')
  })

  it('orders history import before the bank when the fiscal period started over 90 days ago', async () => {
    // The default calendar-year setup starts 1 January: from February on the
    // period has >90 days of history the bank cannot deliver, so the created
    // result must point at SIE-first ordering. Frozen mid-year so the test
    // does not flip in January.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${new Date().getFullYear()}-08-15T12:00:00Z`))
    try {
      const supabase = supabaseWithTeam(TEAM_ID)
      mocks.createCompanyCore.mockImplementation(
        async (_client: unknown, _input: unknown, createRow: () => Promise<{ data: unknown; error: unknown }>) => {
          const { data } = await createRow()
          return { companyId: data as string }
        }
      )
      const result = (await tool.execute(
        { ...setup, confirm: true },
        '',
        'user-1',
        supabase as never
      )) as Record<string, unknown>

      expect(result.history_note).toContain('gnubok_create_sie_upload')
      expect(result.message).toContain('IN ORDER')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a VAT-registered company without a moms period before touching the database', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    await expect(
      tool.execute({ ...setup, moms_period: undefined, confirm: true }, '', 'user-1', supabase as never)
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('moms_period') })
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mocks.createCompanyCore).not.toHaveBeenCalled()
  })

  it('defaults the team to the user PERSONAL team only (WL-08)', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    const result = (await tool.execute(setup, '', 'user-1', supabase as never)) as Record<string, unknown>

    expect((result.preview as Record<string, unknown>).team_id).toBe(TEAM_ID)
    // The default-team lookup must be restricted to kind='personal': picking
    // the first membership regardless of kind attached a consultant's private
    // company to their byrå team.
    expect(supabase.from).toHaveBeenCalledWith('team_members')
    expect(supabase.chain.select).toHaveBeenCalledWith('team_id, teams!inner(kind, created_at)')
    expect(supabase.chain.eq).toHaveBeenCalledWith('teams.kind', 'personal')
  })

  it('leaves team_id null when the user has no personal team', async () => {
    const supabase = supabaseWithTeam(null)
    const result = (await tool.execute(setup, '', 'user-1', supabase as never)) as Record<string, unknown>
    expect((result.preview as Record<string, unknown>).team_id).toBeNull()
  })

  it('uses an explicit team_id over the default team', async () => {
    const supabase = supabaseWithTeam(TEAM_ID)
    const other = '66666666-6666-4666-8666-666666666666'
    const result = (await tool.execute({ ...setup, team_id: other }, '', 'user-1', supabase as never)) as Record<
      string,
      unknown
    >
    expect((result.preview as Record<string, unknown>).team_id).toBe(other)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('surfaces a creation failure as a coded error', async () => {
    const supabase = supabaseWithTeam(null)
    mocks.createCompanyCore.mockResolvedValue({ error: 'Kunde inte skapa kontoplan. Försök igen.' })
    await expect(
      tool.execute({ ...setup, confirm: true }, '', 'user-1', supabase as never)
    ).rejects.toMatchObject({ code: 'COMPANY_CREATE_FAILED' })
  })
})

/**
 * crm#1201: "this connection uses it automatically from the next call" is
 * only true for a user's FIRST company (an unbound key binds to it). A user
 * with another company keeps that default, so the agent must name the new
 * one on every call; an agent that believed the old sentence rendered the
 * SIE card for the old company.
 */
describe('gnubok_create_company: which company the connection uses next', () => {
  const OTHER_COMPANY = '77777777-7777-4777-8777-777777777777'

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createCompanyCore.mockImplementation(
      async (_client: unknown, _input: unknown, createRow: () => Promise<{ data: unknown; error: unknown }>) => {
        const { data } = await createRow()
        return { companyId: data as string }
      }
    )
    // Mid-year, so the created result carries the SIE-first history_note.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${new Date().getFullYear()}-08-15T12:00:00Z`))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** team_members answers the personal team; company_members the user's OTHER memberships (or an error). */
  function supabaseWithMemberships(others: string[] | 'error') {
    const { supabase, calls } = createTableMockSupabase({
      team_members: { data: { team_id: TEAM_ID } },
      company_members: others === 'error' ? { error: { message: 'boom' } } : { data: others.map((id) => ({ company_id: id })) },
      'rpc:create_company_for_user': { data: COMPANY_ID },
    })
    const memberCalls = () => calls.filter((c) => c.table === 'company_members').map((c) => [c.method, c.args])
    return { supabase, memberCalls }
  }

  async function create(others: string[] | 'error', actor?: Record<string, unknown>) {
    const { supabase, memberCalls } = supabaseWithMemberships(others)
    const result = (await tool.execute({ ...setup, confirm: true }, '', 'user-1', supabase as never, actor as never)) as {
      message: string
      history_note?: string
      next: { tool: string; args: Record<string, unknown> }
    }
    return { result, memberCalls: memberCalls() }
  }

  it('says the connection switches to it for a user\'s first company', async () => {
    const { result, memberCalls } = await create([])

    expect(result.message).toContain('This connection uses it automatically from the next call.')
    expect(result.message).toContain('IN ORDER')
    expect(result.history_note).toContain('call gnubok_create_sie_upload to render')
    expect(result.next.args).toEqual({ slug: 'onboarding' })
    // The OTHER memberships of this user, archived companies not counted.
    expect(memberCalls).toEqual(
      expect.arrayContaining([
        ['eq', ['user_id', 'user-1']],
        ['neq', ['company_id', COMPANY_ID]],
        ['is', ['companies.archived_at', null]],
      ])
    )
  })

  it('tells the agent to name the new company on every call when the user has another one', async () => {
    const { result } = await create([OTHER_COMPANY])

    expect(result.message).not.toContain('uses it automatically')
    expect(result.message).toContain(`default company is unchanged: pass company_id=${COMPANY_ID} on every call`)
    expect(result.message).toContain('IN ORDER')
    expect(result.history_note).toContain(`call gnubok_create_sie_upload with company_id=${COMPANY_ID}`)
    expect(result.next).toMatchObject({ tool: 'gnubok_load_skill', args: { slug: 'onboarding', company_id: COMPANY_ID } })
  })

  it('names the company when the membership read fails: right in every case', async () => {
    const { result } = await create('error')
    expect(result.message).toContain(`pass company_id=${COMPANY_ID}`)
  })

  it('says a restricted connection does not reach the new company', async () => {
    const { result } = await create([OTHER_COMPANY], { type: 'api_key', allowedCompanyIds: [OTHER_COMPANY] })

    expect(result.message).toContain('does not reach it')
    expect(result.message).toContain('Agents > Connect an agent')
    expect(result.next.args).toEqual({ slug: 'onboarding' })
  })
})
