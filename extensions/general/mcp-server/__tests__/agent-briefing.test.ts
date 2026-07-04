/**
 * Tests for gnubok_get_agent_briefing: session-bootstrap context for the
 * specialized accountant agent over MCP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tools } from '../server'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    extractBearerToken: vi.fn().mockReturnValue('test-token'),
    validateApiKey: vi.fn().mockResolvedValue({
      userId: 'user-1',
      companyId: 'company-1',
      scopes: ['agent:read'],
    }),
    createServiceClientNoCookies: vi.fn(),
  }
})

/** Builds a supabase mock whose three relevant tables resolve to canned data. */
function mockSupabase(opts: {
  profile?: {
    profile_summary: string | null
    horizontal_atoms: string[] | null
    vertical_atoms: string[] | null
    modifier_atoms: string[] | null
  } | null
  memoryRows?: Array<{
    id: string
    kind: string
    content: string
    relevance_score: number | null
  }>
  atomRows?: Array<{
    id: string
    tier: string
    title: string | null
    description: string
  }>
  // profiles.full_name for the signed-in user. undefined → no profile row.
  userFullName?: string | null
  // companies row for the active company. undefined → no row (null data).
  company?: { name: string | null; org_number: string | null; entity_type: string | null } | null
  // company_settings.accounting_method. undefined → no settings row (null data).
  accountingMethod?: string | null
  // Dimension registry (dimensions PR3). Default: empty → block omitted.
  dimensionRows?: Array<{ id: string; sie_dim_no: number; name: string }>
  dimensionValueRows?: Array<{ dimension_id: string; code: string; name: string }>
  dimensionRuleRows?: Array<{ account_number: string; rule_type: string; dimension_id: string }>
  dimensionsEnabled?: boolean
  errors?: { profile?: string; memory?: string; atoms?: string }
}) {
  const profile = opts.profile === undefined ? null : opts.profile
  const memoryRows = opts.memoryRows ?? []
  const atomRows = opts.atomRows ?? []
  const errors = opts.errors ?? {}

  /** Order-agnostic chainable query resolving to `data` when awaited. */
  const chainResolving = (data: unknown) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data, error: null })
    return chain
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data:
                  opts.userFullName === undefined ? null : { full_name: opts.userFullName },
                error: null,
              }),
            })),
          })),
        }
      }
      if (table === 'agent_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: profile,
                error: errors.profile ? new Error(errors.profile) : null,
              }),
            })),
          })),
        }
      }
      if (table === 'agent_memory') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({
                  order: vi.fn(() => ({
                    limit: vi.fn().mockResolvedValue({
                      data: memoryRows,
                      error: errors.memory ? new Error(errors.memory) : null,
                    }),
                  })),
                })),
              })),
            })),
          })),
        }
      }
      if (table === 'agent_atom_registry') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => ({
              eq: vi.fn().mockResolvedValue({
                data: atomRows,
                error: errors.atoms ? new Error(errors.atoms) : null,
              }),
            })),
          })),
        }
      }
      if (table === 'companies') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data: opts.company === undefined ? null : opts.company,
                error: null,
              }),
            })),
          })),
        }
      }
      if (table === 'company_settings') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn().mockResolvedValue({
                data:
                  opts.accountingMethod === undefined && opts.dimensionsEnabled === undefined
                    ? null
                    : {
                        accounting_method: opts.accountingMethod ?? null,
                        dimensions_enabled: opts.dimensionsEnabled ?? false,
                      },
                error: null,
              }),
            })),
          })),
        }
      }
      if (table === 'dimensions') {
        return chainResolving(opts.dimensionRows ?? [])
      }
      if (table === 'dimension_values') {
        return chainResolving(opts.dimensionValueRows ?? [])
      }
      if (table === 'account_dimension_rules') {
        // PR10: the briefing surfaces active rules; default none.
        return chainResolving(opts.dimensionRuleRows ?? [])
      }
      throw new Error(`Unexpected table in test mock: ${table}`)
    }),
  }
}

describe('gnubok_get_agent_briefing tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is registered with readOnly + idempotent annotations', () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.idempotentHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('inputSchema declares no required args (no inputs)', () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const input = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties: boolean }
    expect(input.additionalProperties).toBe(false)
    expect(input.required).toBeUndefined()
  })

  it('returns null summary, empty atoms, empty memory, null user_name when nothing exists', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      user_name: string | null
      profile_summary: string | null
      atoms: unknown[]
      memory: unknown[]
    }
    expect(result.profile_summary).toBeNull()
    expect(result.atoms).toEqual([])
    expect(result.memory).toEqual([])
    expect(result.user_name).toBeNull()
  })

  it('returns the active company block so the agent can confirm the entity before writing', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: null,
      company: { name: 'Acme AB', org_number: '556677-8899', entity_type: 'aktiebolag' },
      accountingMethod: 'cash',
    })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      company: {
        id: string
        name: string | null
        org_number: string | null
        entity_type: string | null
        accounting_method: string | null
      }
    }
    expect(result.company).toEqual({
      id: 'company-1',
      company_id: 'company-1',
      name: 'Acme AB',
      org_number: '556677-8899',
      entity_type: 'aktiebolag',
      accounting_method: 'cash',
    })
  })

  it('always returns the company id even when the company/settings rows are missing', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      company: { id: string; name: string | null; accounting_method: string | null }
    }
    expect(result.company.id).toBe('company-1')
    expect((result.company as { company_id?: string }).company_id).toBe('company-1')
    expect(result.company.name).toBeNull()
    expect(result.company.accounting_method).toBeNull()
  })

  it('returns only the first name (tilltalsnamn): data minimisation, not the full legal name', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null, userFullName: 'Peter Bennet' })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { user_name: string | null }
    // GDPR Art.5(1)(c): the surname never enters the LLM prompt.
    expect(result.user_name).toBe('Peter')
  })

  it('treats a blank full_name as no name (null)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null, userFullName: '   ' })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { user_name: string | null }
    expect(result.user_name).toBeNull()
  })

  it('returns profile + atom metadata + memory when populated', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: {
        profile_summary: 'Du driver Acme AB som IT-konsult …',
        horizontal_atoms: ['horizontal/swedish-vat'],
        vertical_atoms: ['vertical/konsult-it'],
        modifier_atoms: ['modifier/single-shareholder-ab-fmb'],
      },
      atomRows: [
        { id: 'horizontal/swedish-vat', tier: 'horizontal', title: 'Swedish VAT', description: 'Moms compliance' },
        { id: 'vertical/konsult-it', tier: 'vertical', title: 'IT-konsult', description: 'SNI 62' },
        { id: 'modifier/single-shareholder-ab-fmb', tier: 'modifier', title: 'Fåmansbolag', description: 'AB single shareholder' },
      ],
      memoryRows: [
        { id: 'mem-1', kind: 'fact', content: 'Hyresavtal löper t.o.m. 2027', relevance_score: 0.9 },
        { id: 'mem-2', kind: 'preference', content: 'Föredrar månadsslut den 25:e', relevance_score: 0.7 },
      ],
    })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      profile_summary: string | null
      atoms: Array<{ id: string; tier: string; title: string; description: string }>
      memory: Array<{ id: string; kind: string; content: string; relevance_score: number | null }>
    }
    expect(result.profile_summary).toContain('Acme AB')
    expect(result.atoms).toHaveLength(3)
    expect(result.atoms.map((a) => a.id).sort()).toEqual([
      'horizontal/swedish-vat',
      'modifier/single-shareholder-ab-fmb',
      'vertical/konsult-it',
    ])
    expect(result.memory).toHaveLength(2)
    expect(result.memory[0].id).toBe('mem-1') // top-ranked
    expect(result.memory[0].relevance_score).toBe(0.9)
  })

  it('handles profile present but no atoms loaded yet', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: {
        profile_summary: 'Composer ran but selected nothing.',
        horizontal_atoms: null,
        vertical_atoms: null,
        modifier_atoms: null,
      },
    })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      profile_summary: string | null
      atoms: unknown[]
      memory: unknown[]
    }
    expect(result.profile_summary).toBe('Composer ran but selected nothing.')
    expect(result.atoms).toEqual([])
  })

  it('surfaces a structured error if the profile query fails', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null, errors: { profile: 'pg-down' } })
    await expect(
      tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    ).rejects.toThrow(/Failed to load agent profile.*pg-down/)
  })

  it('surfaces a structured error if the memory query fails', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null, errors: { memory: 'rls-denied' } })
    await expect(
      tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })
    ).rejects.toThrow(/Failed to load agent memory.*rls-denied/)
  })

  it('omits the dimensions block entirely when the registry is empty', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as Record<string, unknown>
    expect('dimensions' in result).toBe(false)
  })

  it('returns the dimensions block with enabled flag, counts, and top values capped at 10', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const manyValues = Array.from({ length: 12 }, (_, i) => ({
      dimension_id: 'dim-6',
      code: `P${String(i + 1).padStart(3, '0')}`,
      name: `Projekt ${i + 1}`,
    }))
    const supabase = mockSupabase({
      profile: null,
      dimensionsEnabled: true,
      dimensionRows: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe' },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt' },
      ],
      dimensionValueRows: [
        { dimension_id: 'dim-1', code: 'KS01', name: 'Stockholm' },
        ...manyValues,
      ],
    })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      dimensions?: {
        enabled: boolean
        dimensions: Array<{
          sie_dim_no: number
          name: string
          active_value_count: number
          top_values: Array<{ code: string; name: string }>
        }>
      }
    }
    expect(result.dimensions).toBeDefined()
    expect(result.dimensions!.enabled).toBe(true)
    expect(result.dimensions!.dimensions).toHaveLength(2)
    const [ks, projekt] = result.dimensions!.dimensions
    expect(ks).toMatchObject({ sie_dim_no: 1, name: 'Kostnadsställe', active_value_count: 1 })
    expect(ks.top_values).toEqual([{ code: 'KS01', name: 'Stockholm' }])
    expect(projekt.active_value_count).toBe(12)
    expect(projekt.top_values).toHaveLength(10) // capped
  })

  it('reports enabled=false in the dimensions block when the toggle is off but values exist', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: null,
      dimensionsEnabled: false,
      dimensionRows: [{ id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }],
      dimensionValueRows: [{ dimension_id: 'dim-6', code: 'P001', name: 'Villa Almgren' }],
    })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { dimensions?: { enabled: boolean } }
    expect(result.dimensions?.enabled).toBe(false)
  })
})
