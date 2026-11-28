/**
 * Tests for gnubok_get_agent_briefing: session-bootstrap context for the
 * specialized accountant agent over MCP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tools } from '../server'
import {
  RECOMMENDED_WORKFLOW_LOADOUTS,
  WORKFLOW_SKILLS_WITHOUT_LOADOUT,
  annotateLoadoutTools,
  assertRecommendedLoadoutsValid,
  type RecommendedToolEntry,
} from '../recommended-tools'
import { workflowSkills } from '../skills'
import { isDefaultCatalogTool } from '../tool-reach'
import { ALL_SCOPES, DEFAULT_OAUTH_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { companyMembersChain, createPagedMockSupabase, manyRows } from '@/tests/helpers'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/suggestions/list', () => ({
  listOpenSuggestions: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/questions/list', () => ({
  listOpenQuestionsForBriefing: vi.fn().mockResolvedValue([]),
  listQuestions: vi.fn(),
}))

vi.mock('@/lib/grants/review', () => ({
  loadGrantReview: vi.fn().mockResolvedValue({ postings: [], paused: false, has_active_grants: false }),
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
  // bank_connections.last_synced_at of the latest sync (crm#1454). undefined → no connection.
  bankLastSyncedAt?: string
  profile?: {
    // Stored rows still carry the summary the removed build wrote; the briefing never hands it on.
    profile_summary?: string | null
    horizontal_atoms: string[] | null
    vertical_atoms: string[] | null
    modifier_atoms: string[] | null
  } | null
  memoryRows?: Array<{
    id: string
    kind: string
    content: string
    relevance_score: number | null
    created_at?: string | null
    created_by_user_id?: string | null
    origin?: string | null
    client?: string | null
  }>
  // profiles rows the creators' read (.in('id', ...)) returns.
  creatorProfiles?: Array<{ id: string; full_name: string | null; deleted_at: string | null; anonymized_at: string | null }>
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
  // company_settings.company_name: the name edited in Inställningar.
  settingsCompanyName?: string | null
  // Dimension registry (dimensions PR3). Default: empty → block omitted.
  dimensionRows?: Array<{ id: string; sie_dim_no: number; name: string }>
  dimensionValueRows?: Array<{ dimension_id: string; code: string; name: string }>
  dimensionRuleRows?: Array<{ account_number: string; rule_type: string; dimension_id: string }>
  dimensionsEnabled?: boolean
  // skatteverket_tokens rows for the connection-health block. Default: none.
  skvTokenRows?: Array<{
    user_id: string
    status: string | null
    created_at: string | null
    expires_at?: string | null
    refresh_count?: number | null
    refresh_token?: string | null
  }>
  // company_inboxes.local_part of the active inbox (crm#1174). undefined → no row.
  inboxLocalPart?: string
  errors?: { profile?: string; memory?: string; atoms?: string; dimensionValues?: string }
}) {
  const profile = opts.profile === undefined ? null : opts.profile
  const memoryRows = opts.memoryRows ?? []
  const atomRows = opts.atomRows ?? []
  const errors = opts.errors ?? {}
  // The values read pages like PostgREST: at most 1,000 rows a request.
  const pagedValues = createPagedMockSupabase({ dimension_values: opts.dimensionValueRows ?? [] })

  /** Order-agnostic chainable query resolving to `data` when awaited. */
  const chainResolving = (data: unknown) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data, error: null })
    return chain
  }

  return {
    findCalls: pagedValues.findCalls,
    from: vi.fn((table: string) => {
      if (table === 'company_skills') return chainResolving([])
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
            in: vi.fn().mockResolvedValue({ data: opts.creatorProfiles ?? [], error: null }),
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
                is: vi.fn(() => ({
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
              eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({
                data: atomRows,
                error: errors.atoms ? new Error(errors.atoms) : null,
              }) })),
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
                  opts.accountingMethod === undefined &&
                  opts.dimensionsEnabled === undefined &&
                  opts.settingsCompanyName === undefined
                    ? null
                    : {
                        accounting_method: opts.accountingMethod ?? null,
                        dimensions_enabled: opts.dimensionsEnabled ?? false,
                        company_name: opts.settingsCompanyName ?? null,
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
        if (errors.dimensionValues) {
          const failing = chainResolving(null)
          failing.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: errors.dimensionValues } })
          return failing
        }
        return pagedValues.supabase.from(table)
      }
      if (table === 'account_dimension_rules') {
        // PR10: the briefing surfaces active rules; default none.
        return chainResolving(opts.dimensionRuleRows ?? [])
      }
      if (table === 'skatteverket_tokens') {
        return chainResolving(opts.skvTokenRows ?? [])
      }
      if (table === 'company_members') {
        // Every token owner is still a member of the company.
        return companyMembersChain((opts.skvTokenRows ?? []).map((row) => row.user_id))
      }
      if (table === 'bank_connections') {
        const chain: Record<string, unknown> = {}
        for (const method of ['select', 'eq', 'not', 'order', 'limit']) chain[method] = vi.fn(() => chain)
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: opts.bankLastSyncedAt ? { last_synced_at: opts.bankLastSyncedAt } : null,
          error: null,
        })
        return chain
      }
      if (table === 'company_inboxes') {
        const chain = chainResolving(null) as Record<string, unknown>
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: opts.inboxLocalPart === undefined ? null : { local_part: opts.inboxLocalPart },
          error: null,
        })
        return chain
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

  it('reports the latest bank sync in data_status, null without a bank connection (crm#1454)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const synced = (await tool.execute({}, 'company-1', 'user-1', mockSupabase({ profile: null, bankLastSyncedAt: '2026-10-25T06:00:00Z' }) as never, { type: 'api_key' })) as {
      data_status: { bank_last_synced_at: string | null }
    }
    expect(synced.data_status).toEqual({ bank_last_synced_at: '2026-10-25T06:00:00Z' })
    const none = (await tool.execute({}, 'company-1', 'user-1', mockSupabase({ profile: null }) as never, { type: 'api_key' })) as {
      data_status: { bank_last_synced_at: string | null }
    }
    expect(none.data_status).toEqual({ bank_last_synced_at: null })
  })

  it('returns empty atoms, empty memory, null user_name when nothing exists', async () => {
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
      atoms: unknown[]
      memory: unknown[]
    }
    // The key stays, always null: an earlier tools/list declared it required.
    expect(result).toHaveProperty('profile_summary', null)
    for (const key of ['company', 'user_name', 'profile_summary', 'atoms', 'memory', 'recommended_tools']) {
      expect(result).toHaveProperty(key)
    }
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

  it('names the company as Inställningar does after a rename: feedback seq 580571, 670221', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: null,
      company: { name: 'Piteå kyl & hushåll', org_number: '556677-8899', entity_type: 'aktiebolag' },
      settingsCompanyName: 'Exempelbolaget',
    })
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      company: { name: string | null }
    }
    expect(result.company.name).toBe('Exempelbolaget')
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

  it('returns atom metadata + memory when populated, and never the summary the removed build stored', async () => {
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
      atoms: Array<{ id: string; tier: string; title: string; description: string }>
      memory: Array<{ id: string; kind: string; content: string; relevance_score: number | null }>
      where_to_find: string[]
    }
    expect(result).toHaveProperty('profile_summary', null)
    expect(JSON.stringify(result)).not.toContain('som IT-konsult')
    expect(result.where_to_find.join(' ')).not.toContain('profile_summary')
    expect(Object.keys((tool.outputSchema as { properties: Record<string, unknown> }).properties)).not.toContain('profile_summary')
    expect(result.atoms).toHaveLength(3)
    expect(result.atoms.map((a) => a.id).sort()).toEqual([
      'horizontal/swedish-vat',
      'modifier/single-shareholder-ab-fmb',
      'vertical/konsult-it',
    ])
    expect(result.memory).toHaveLength(2)
    expect(result.memory[0].id).toBe('mem-1') // query order: newest first
    expect(result.memory[0].relevance_score).toBe(0.9)
  })

  it('sends every fact with who taught it, the last sync from the AI\'s own memory, and where to find things', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: null,
      memoryRows: [
        { id: 'mem-3', kind: 'fact', content: 'Hyran höjs till 14 000 kr från januari.', relevance_score: 0.8, created_at: '2026-10-20T09:00:00Z', created_by_user_id: 'u-anna', origin: 'conversation', client: 'claude' },
        { id: 'mem-2', kind: 'fact', content: 'Två anställda sedan september.', relevance_score: 0.8, created_at: '2026-10-02T09:00:00Z', created_by_user_id: 'u-gone', origin: 'session_sync', client: 'chatgpt' },
        { id: 'mem-1', kind: 'fact', content: 'Gammal fakta utan ursprung.', relevance_score: 0.8, created_at: '2026-06-01T09:00:00Z', created_by_user_id: 'u-noname', origin: null, client: null },
      ],
      creatorProfiles: [
        { id: 'u-anna', full_name: 'Anna Andersson', deleted_at: null, anonymized_at: null },
        { id: 'u-gone', full_name: null, deleted_at: '2026-10-05T00:00:00Z', anonymized_at: '2026-10-05T00:00:00Z' },
        { id: 'u-noname', full_name: null, deleted_at: null, anonymized_at: null },
      ],
    })
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      memory: Array<Record<string, unknown>>
      memory_sync: { last_synced_at: string | null; note: string }
      where_to_find: string[]
      memory_truncated?: boolean
    }
    expect(result.memory).toHaveLength(3)
    expect(result.memory[0]).toMatchObject({ fact_id: 'mem-3', saved_at: '2026-10-20T09:00:00Z', origin: 'conversation', client: 'claude', created_by: 'Anna Andersson' })
    // Who saved it: the name, or that the account is gone; never an e-mail or a placeholder.
    expect(result.memory[1]).toMatchObject({ created_by_deleted: true })
    expect(result.memory[1]).not.toHaveProperty('created_by')
    expect(result.memory[2]).not.toHaveProperty('created_by')
    expect(result.memory[2]).not.toHaveProperty('created_by_deleted')
    // No origin recorded: the keys are left out, not sent as null.
    expect(result.memory[2]).not.toHaveProperty('origin')
    expect(result.memory[2]).not.toHaveProperty('client')
    expect(result.memory_sync.last_synced_at).toBe('2026-10-02T09:00:00Z')
    expect(result.memory_sync.note).toContain('origin: session_sync')
    expect(result.where_to_find.join(' ')).toContain('gnubok_remember_fact')
    // The memory line says where a note about one purchase belongs, in the tool description's own sentence.
    const purchaseNotePlace =
      "A note about one purchase or verifikat (who took part, what a receipt was for) goes on that verifikat with gnubok_set_voucher_note or in the booking's description, not here."
    expect(result.where_to_find[0]).toMatch(/^memory: /)
    expect(result.where_to_find[0]).toContain(purchaseNotePlace)
    expect(tools.find((t) => t.name === 'gnubok_remember_fact')!.description).toContain(purchaseNotePlace)
    expect(result.memory_truncated).toBeUndefined()
  })

  it('states no sync yet when no fact came from the AI\'s own memory', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      memory_sync: { last_synced_at: string | null }
    }
    expect(result.memory_sync.last_synced_at).toBeNull()
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
      atoms: unknown[]
      memory: unknown[]
    }
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

  it('counts every active value past 1,000 rows, a dimension whose codes sort last included (crm#2152)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const projects = manyRows(1500, (i) => ({ dimension_id: 'dim-6', code: `P${String(i).padStart(5, '0')}`, name: `Projekt ${i}` }))
    const costCentres = ['X1', 'X2', 'X3'].map((code) => ({ dimension_id: 'dim-1', code, name: `Kostnadsställe ${code}` }))
    const supabase = mockSupabase({
      profile: null,
      dimensionsEnabled: true,
      dimensionRows: [
        { id: 'dim-1', sie_dim_no: 1, name: 'Kostnadsställe' },
        { id: 'dim-6', sie_dim_no: 6, name: 'Projekt' },
      ],
      // Ordered by code across the company, as the read orders them.
      dimensionValueRows: [...projects, ...costCentres],
    })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      dimensions?: { dimensions: Array<{ sie_dim_no: number; active_value_count: number; top_values: Array<{ code: string }> }> }
    }

    const [ks, projekt] = result.dimensions!.dimensions
    expect(ks).toMatchObject({ sie_dim_no: 1, active_value_count: 3 })
    expect(ks.top_values.map((v) => v.code)).toEqual(['X1', 'X2', 'X3'])
    expect(projekt).toMatchObject({ sie_dim_no: 6, active_value_count: 1500 })
    expect(projekt.top_values.map((v) => v.code)).toEqual(projects.slice(0, 10).map((v) => v.code))
    // Every page reads the company's active values (the MCP client has no RLS
    // to fall back on) on a total order: a code is unique only inside its dimension.
    const pages = supabase.findCalls('dimension_values', 'range')
    const filters = supabase.findCalls('dimension_values', 'eq')
    const orders = supabase.findCalls('dimension_values', 'order').map(([column]) => column)
    expect(pages.length).toBeGreaterThan(1)
    expect(filters).toEqual(pages.flatMap(() => [['company_id', 'company-1'], ['is_active', true]]))
    expect(orders).toEqual(pages.flatMap(() => ['code', 'id']))
  })

  it('omits the dimensions block, and still briefs, when the values read fails', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({
      profile: null,
      dimensionRows: [{ id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }],
      errors: { dimensionValues: 'canceling statement due to statement timeout' },
    })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as Record<string, unknown>

    expect('dimensions' in result).toBe(false)
    expect(result.company).toBeDefined()
  })
})

// Defined measures (lib/measures): the briefing says they exist and how to
// reach them, never a value (a value in the briefing would be stale by the
// time the agent quotes it).
describe('measures pointer', () => {
  it('names gnubok_get_measure and every measure id, with no figures', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      measures: { tool: string; how: string }
    }
    expect(result.measures.tool).toBe('gnubok_get_measure')
    expect(tools.some((t) => t.name === result.measures.tool)).toBe(true)
    for (const id of ['vat_payable', 'accounts_receivable', 'bank_balance', 'unpaid_supplier_invoices']) {
      expect(result.measures.how).toContain(id)
    }
    expect(result.measures.how).toContain('gnubok_explain_measure')
    expect(result.measures.how).not.toMatch(/\d{3}/)
  })
})

// crm#1174: an agent asked to route a card provider's receipts into Accounted
// looked in the briefing and the inbox list for the company's inbox address,
// found neither, and told the user there was none. The address existed.
describe('inbox block (crm#1174)', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!

  afterEach(() => {
    delete process.env.RESEND_INBOUND_DOMAIN
  })

  it('carries the company inbox address with one sentence on what forwarding does', async () => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
    const supabase = mockSupabase({ profile: null, inboxLocalPart: 'acme-7f3k' })
    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      inbox: { address: string | null; note: string }
    }
    expect(result.inbox.address).toBe('acme-7f3k@in.example.test')
    expect(result.inbox.note).toMatch(/^Forward mail here/)
    expect(result.inbox.note).toContain('mail body')
    // crm#1171: an agent holding the bytes mailed them and waited instead.
    expect(result.inbox.note).toContain('gnubok_create_document_upload')
    expect(result.inbox.note).toContain('gnubok_complete_document_upload')
  })

  it('states that there is no address instead of leaving the key out', async () => {
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      inbox: { address: string | null; note: string }
    }
    expect(result.inbox.address).toBeNull()
    expect(result.inbox.note).toContain('No inbox address')
    expect(result.inbox.note).toContain('gnubok_create_document_upload')
  })

  it('names the inbox address in the description, where an agent decides what to call', () => {
    expect(tool().description).toContain('inbox address')
  })

  // crm#1334: the company was renamed, the address kept the old name, and the
  // agent found no tool and no word on where to change it.
  it('says where to get an address with the current name once a rename left the old one', async () => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
    const supabase = mockSupabase({
      profile: null,
      inboxLocalPart: 'gammalt-namn-ab-m4tz',
      company: { name: 'Nytt Namn AB', org_number: null, entity_type: 'aktiebolag' },
    })
    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      inbox: { address: string | null; earlier_name?: string }
    }
    expect(result.inbox.address).toBe('gammalt-namn-ab-m4tz@in.example.test')
    expect(result.inbox.earlier_name).toContain('Lägg till brevlåda')
    expect(result.inbox.earlier_name).toContain('keeps receiving')
  })

  it('says nothing more while the address carries the name', async () => {
    process.env.RESEND_INBOUND_DOMAIN = 'in.example.test'
    const supabase = mockSupabase({
      profile: null,
      inboxLocalPart: 'nytt-namn-ab-m4tz',
      company: { name: 'Nytt Namn AB', org_number: null, entity_type: 'aktiebolag' },
    })
    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      inbox: Record<string, unknown>
    }
    expect(Object.keys(result.inbox).sort()).toEqual(['address', 'note'])
  })
})

// Capabilities digest (lib/modules/capabilities.ts): the modules this
// company cannot use right now, so an agent stops calling their tools.
describe('capabilities digest', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
  const COMPANY = '11111111-1111-4111-8111-111111111111'
  const ALL_GRANTS = ['ai', 'bank_sync', 'skatteverket', 'collections'].map((key) => ({
    capability_key: key,
    expires_at: null,
    source: 'stripe',
    team_id: null,
  }))

  /** The briefing mock plus the reads the capabilities report makes. */
  function withCapabilityReads(opts: {
    entityType: string
    paysSalaries: boolean | null
    grants: unknown[] | null
    grantsError?: { message: string }
    disabled?: string[]
  }) {
    const base = mockSupabase({ profile: null })
    const single = (data: unknown) => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) })) })),
    })
    const thenable = (data: unknown) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in']) chain[m] = vi.fn(() => chain)
      chain.then = (resolve: (v: unknown) => void) => resolve({ data, error: null })
      return chain
    }
    return {
      from: vi.fn((table: string) => {
        if (table === 'companies') {
          return single({ name: 'Firman', org_number: null, entity_type: opts.entityType, jurisdiction: 'SE', ledger_currency: 'SEK' })
        }
        if (table === 'company_settings') {
          return single({
            accounting_method: null,
            dimensions_enabled: false,
            company_name: null,
            entity_type: opts.entityType,
            pays_salaries: opts.paysSalaries,
          })
        }
        if (table === 'company_capability_config') {
          return thenable((opts.disabled ?? []).map((key) => ({ capability_key: key })))
        }
        return base.from(table)
      }),
      rpc: vi.fn(async (fn: string) =>
        fn === 'company_capability_grant_rows'
          ? { data: opts.grants, error: opts.grantsError ?? null }
          : { data: null, error: { message: `no ${fn} in this mock` } },
      ),
    }
  }

  // In the Bolaget rollout unless a test says otherwise, so each digest
  // below shows only what its test is about.
  beforeEach(() => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('names Avtal och åtaganden under year-end when the rollout does not name the company', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    const supabase = withCapabilityReads({ entityType: 'aktiebolag', paysSalaries: null, grants: ALL_GRANTS })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      capabilities?: unknown
    }
    expect(result.capabilities).toEqual([
      { id: 'year-end', status: 'active', reasons: [], parts: [{ id: 'commitments', status: 'off', reasons: ['switched_on_per_company'] }] },
    ])
  })

  it('lists only the modules that are not active, as id, status and reasons', async () => {
    const supabase = withCapabilityReads({
      entityType: 'enskild_firma',
      paysSalaries: false,
      grants: ALL_GRANTS.filter((g) => g.capability_key !== 'collections'),
    })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      capabilities?: unknown
    }
    expect(result.capabilities).toEqual([
      { id: 'payroll', status: 'unsupported', reasons: ['unsupported_legal_form'] },
      { id: 'collections', status: 'needs_plan', reasons: ['needs_plan'] },
    ])
  })

  it('states an empty list when every module is active', async () => {
    const supabase = withCapabilityReads({ entityType: 'aktiebolag', paysSalaries: null, grants: ALL_GRANTS })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      capabilities?: unknown
    }
    expect(result.capabilities).toEqual([])
  })

  it('names the profile beside the digest: Standard, implicit, no package off, for a company without a stored one', async () => {
    const supabase = withCapabilityReads({ entityType: 'aktiebolag', paysSalaries: null, grants: ALL_GRANTS })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      capabilities_profile?: unknown
    }
    expect(result.capabilities_profile).toEqual({
      id: 'standard',
      version: 1,
      name: 'Standard (everything on)',
      name_sv: 'Standard (allt på)',
      source: 'implicit',
      packages_off: [],
    })
  })

  it('leaves the key out, and still briefs, when the report cannot be read', async () => {
    const supabase = withCapabilityReads({
      entityType: 'aktiebolag',
      paysSalaries: null,
      grants: null,
      grantsError: { message: 'statement timeout' },
    })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      capabilities?: unknown
      company: { company_id: string }
    }
    expect(result).not.toHaveProperty('capabilities')
    expect(result).not.toHaveProperty('capabilities_profile')
    expect(result.company.company_id).toBe(COMPANY)
  })
})

describe('suggestions (Profiles and Suggestions, step 3)', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
  // Not a uuid, as in the blocks above: the capabilities read refuses it at
  // once instead of reaching tables this mock does not shape.
  const COMPANY = 'company-1'

  it('lists the open suggestions compactly, with how to answer each through approve and reject', async () => {
    const { listOpenSuggestions } = await import('@/lib/suggestions/list')
    vi.mocked(listOpenSuggestions).mockResolvedValueOnce([
      {
        suggestion_id: 's-1',
        pending_operation_id: 'op-1',
        detector: 'first-employee',
        suggestion_key: 'enable_package:payroll',
        operation_type: 'enable_package',
        package_id: 'payroll',
        title: 'Slå på Lön?',
        reason: 'Du har registrerat en anställd.',
        created_at: '2026-10-16T10:00:00Z',
      },
    ])
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      suggestions?: unknown
      suggestions_how?: string
    }
    expect(listOpenSuggestions).toHaveBeenCalledWith(supabase, COMPANY)
    expect(result.suggestions).toEqual([
      { suggestion_id: 's-1', operation_id: 'op-1', title: 'Slå på Lön?', reason: 'Du har registrerat en anställd.' },
    ])
    expect(result.suggestions_how).toContain('gnubok_approve_pending_operation')
    expect(result.suggestions_how).toContain('gnubok_reject_pending_operation')
    expect(result.suggestions_how).toContain('"Visa aldrig"')
    expect(JSON.stringify(result.suggestions).length + (result.suggestions_how?.length ?? 0)).toBeLessThan(800)
  })

  it('leaves both keys out when nothing is open, so a company without suggestions pays nothing', async () => {
    const supabase = mockSupabase({ profile: null })
    const result = await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })
    expect(result).not.toHaveProperty('suggestions')
    expect(result).not.toHaveProperty('suggestions_how')
  })
})

describe('open questions (the question list)', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
  const COMPANY = 'company-1'

  it('lists the open questions with their options and why, and says how to answer one', async () => {
    const { listOpenQuestionsForBriefing } = await import('@/lib/questions/list')
    vi.mocked(listOpenQuestionsForBriefing).mockResolvedValueOnce([
      {
        question_id: 'q-1',
        status: 'open',
        close_reason: null,
        question: 'Leverantören drog 4 990 kr den 3 november. Vad gäller köpet?',
        why: 'Det avgör hur raden bokförs.',
        options: [
          { id: 'licences', label: 'Fler licenser' },
          { id: 'annual', label: 'Årsbetalning' },
        ],
        evidence: [{ kind: 'transaction', id: '10000000-0000-4000-8000-000000000001' }],
        asked_by: 'Claude',
        client: 'claude',
        answer_option: null,
        answer_text: null,
        answered_at: null,
        answered_via: null,
        fact_id: null,
        created_at: '2026-11-19T08:00:00Z',
      },
    ])
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      open_questions?: unknown
      open_questions_how?: string
    }
    expect(listOpenQuestionsForBriefing).toHaveBeenCalledWith(supabase, COMPANY)
    expect(result.open_questions).toEqual([
      {
        question_id: 'q-1',
        question: 'Leverantören drog 4 990 kr den 3 november. Vad gäller köpet?',
        options: [
          { option_id: 'licences', label: 'Fler licenser' },
          { option_id: 'annual', label: 'Årsbetalning' },
        ],
        why: 'Det avgör hur raden bokförs.',
        asked_at: '2026-11-19T08:00:00Z',
      },
    ])
    expect(result.open_questions_how).toContain('gnubok_remember_fact')
    expect(result.open_questions_how).toContain('answers_question_id')
  })

  it('leaves both keys out when nothing is open or the list is not switched on', async () => {
    const supabase = mockSupabase({ profile: null })
    const result = await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })
    expect(result).not.toHaveProperty('open_questions')
    expect(result).not.toHaveProperty('open_questions_how')
  })
})

describe('grants (Profiles and Suggestions, step 4)', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
  const COMPANY = 'company-1'

  it('lists what the company rules booked since the last review, compactly, with how they work', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'true')
    const { loadGrantReview } = await import('@/lib/grants/review')
    vi.mocked(loadGrantReview).mockResolvedValueOnce({
      paused: false,
      has_active_grants: true,
      postings: [
        {
          use_id: 'u-1', grant_id: 'g-1', grant_version: 2, operation_type: 'categorize_transaction', counterparty_label: 'Spotify AB',
          account_number: '5420', item_lines: [], amount_limit_sek: 200, grant_accepted_at: '2026-10-12T10:00:00Z', grant_revoked_at: null,
          pending_operation_id: 'op-1', transaction_id: 't-1', supplier_invoice_id: null, inbox_item_id: null, journal_entry_id: 'je-1',
          voucher: 'A12', entry_status: 'reversed', entry_date: '2026-10-14', amount_sek: 149, pattern_verified: true,
          committed_at: '2026-10-14T08:00:00Z', reviewed_at: null,
        },
      ],
    })
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      grants?: { paused: boolean; posted_since_review: unknown[]; how: string }
    }
    expect(loadGrantReview).toHaveBeenCalledWith(supabase, COMPANY, { limit: 10 })
    expect(result.grants).toEqual({
      paused: false,
      posted_since_review: [
        { journal_entry_id: 'je-1', voucher: 'A12', entry_date: '2026-10-14', amount_sek: 149, counterparty: 'Spotify AB', grant_id: 'g-1', grant_version: 2, undone: true },
      ],
      how: expect.stringContaining('Bokfört enligt regel'),
    })
    expect(JSON.stringify(result.grants).length).toBeLessThan(900)
    vi.unstubAllEnvs()
  })

  it("names a supplier invoice a rule booked, with the invoice, and says how supplier invoices qualify", async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'true')
    const { loadGrantReview } = await import('@/lib/grants/review')
    vi.mocked(loadGrantReview).mockResolvedValueOnce({
      paused: false,
      has_active_grants: true,
      postings: [
        {
          use_id: 'u-2', grant_id: 'g-2', grant_version: 1, operation_type: 'create_supplier_invoice_from_inbox',
          counterparty_label: 'Telia Sverige AB', account_number: '', item_lines: ['6212:25'], amount_limit_sek: 1500,
          grant_accepted_at: '2026-10-12T10:00:00Z', grant_revoked_at: null, pending_operation_id: 'op-2', transaction_id: null,
          supplier_invoice_id: 'si-1', inbox_item_id: 'in-1', journal_entry_id: 'je-2', voucher: 'A13', entry_status: 'posted',
          entry_date: '2026-10-15', amount_sek: 1249, pattern_verified: true, committed_at: '2026-10-15T08:00:00Z', reviewed_at: null,
        },
      ],
    })
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      grants?: { posted_since_review: unknown[]; how: string }
    }
    expect(result.grants?.posted_since_review).toEqual([
      {
        journal_entry_id: 'je-2', voucher: 'A13', entry_date: '2026-10-15', amount_sek: 1249, counterparty: 'Telia Sverige AB',
        grant_id: 'g-2', grant_version: 1, kind: 'supplier_invoice', supplier_invoice_id: 'si-1', inbox_item_id: 'in-1',
      },
    ])
    expect(result.grants?.how).toContain('gnubok_create_supplier_invoice_from_inbox')
    expect(JSON.stringify(result.grants).length).toBeLessThan(900)
    vi.unstubAllEnvs()
  })

  it('says the rules are switched off while GRANT_SUGGESTIONS is off, and still lists what they booked', async () => {
    vi.stubEnv('GRANT_SUGGESTIONS', 'false')
    const { loadGrantReview } = await import('@/lib/grants/review')
    vi.mocked(loadGrantReview).mockResolvedValueOnce({ paused: false, has_active_grants: true, postings: [] })
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      grants?: { switched_off?: boolean; how: string }
    }
    expect(result.grants).toMatchObject({ switched_off: true, how: expect.stringContaining('switched off') })
    vi.unstubAllEnvs()
  })

  it('marks a grant suggestion as accepted by the person in the app only', async () => {
    const { listOpenSuggestions } = await import('@/lib/suggestions/list')
    vi.mocked(listOpenSuggestions).mockResolvedValueOnce([
      {
        suggestion_id: 's-2',
        pending_operation_id: 'op-2',
        detector: 'grant-candidate',
        suggestion_key: 'create_grant:cp-0123456789abcdef',
        operation_type: 'create_grant',
        package_id: null,
        title: 'Godkänn Spotify AB automatiskt nästa gång, upp till 200 kr?',
        reason: 'Samma motpart bokad på samma sätt 5 gånger.',
        created_at: '2026-10-16T10:00:00Z',
      },
    ])
    const supabase = mockSupabase({ profile: null })
    const result = (await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })) as {
      suggestions?: Array<Record<string, unknown>>
      suggestions_how?: string
    }
    expect(result.suggestions).toEqual([expect.objectContaining({ operation_id: 'op-2', accept: 'person_in_app' })])
    expect(result.suggestions_how).toContain('person_in_app')
    expect(result.suggestions_how).toContain('Att göra')
  })

  it('leaves the key out for a company without grants', async () => {
    const supabase = mockSupabase({ profile: null })
    const result = await tool().execute({}, COMPANY, 'user-1', supabase as never, { type: 'api_key' })
    expect(result).not.toHaveProperty('grants')
  })
})

describe('skatteverket_connection health block', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
  const originalEnabled = process.env.SKATTEVERKET_ENABLED
  // The filing readiness reads on the service role whichever client the tool
  // gets (skv-connection-health.ts), as on MCP: it reads the same rows here.
  const withServiceReads = <T>(supabase: T): T => {
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    return supabase
  }

  beforeEach(() => {
    process.env.SKATTEVERKET_ENABLED = 'true'
  })

  afterEach(() => {
    vi.mocked(createServiceClientNoCookies).mockReset()
    if (originalEnabled === undefined) delete process.env.SKATTEVERKET_ENABLED
    else process.env.SKATTEVERKET_ENABLED = originalEnabled
  })

  it('omits the block entirely for a company that never connected', async () => {
    const supabase = withServiceReads(mockSupabase({ profile: null, skvTokenRows: [] }))
    const result = (await tool().execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as Record<string, unknown>
    expect('skatteverket_connection' in result).toBe(false)
  })

  it('omits the block when the skatteverket extension is disabled, even with a token row', async () => {
    process.env.SKATTEVERKET_ENABLED = 'false'
    const supabase = withServiceReads(mockSupabase({
      profile: null,
      skvTokenRows: [{ user_id: 'user-1', status: 'active', created_at: '2026-08-25T09:12:00Z' }],
    }))
    const result = (await tool().execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as Record<string, unknown>
    expect('skatteverket_connection' in result).toBe(false)
  })

  it('reports an active personal session with its connect time (the ~65 min fuse)', async () => {
    const connectedAt = new Date(Date.now() - 5 * 60_000).toISOString()
    const supabase = withServiceReads(mockSupabase({
      profile: null,
      skvTokenRows: [{
        user_id: 'user-1',
        status: 'active',
        created_at: connectedAt,
        expires_at: new Date(Date.now() + 55 * 60_000).toISOString(),
        refresh_count: 0,
        refresh_token: 'ciphertext',
      }],
    }))
    const result = (await tool().execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      skatteverket_connection?: {
        status: string
        source: string
        connected_at?: string | null
        message?: string
      }
    }
    expect(result.skatteverket_connection).toEqual({
      status: 'active',
      source: 'user',
      connected_at: connectedAt,
      // The session is the caller's own, so the filing tools will work.
      filing: { ready: true, own_session: 'active' },
    })
  })

  it("crm#1263: active through another member's session, but this caller cannot file", async () => {
    // Member user-2 connected minutes ago; the caller's own row expired weeks
    // ago. The status line stays the company's truth, and `filing` says what
    // gnubok_vat_declaration_validate/_submit will answer this caller.
    const memberConnectedAt = new Date(Date.now() - 3 * 60_000).toISOString()
    const supabase = withServiceReads(mockSupabase({
      profile: null,
      userFullName: 'Anna Admin',
      skvTokenRows: [
        {
          user_id: 'user-2',
          status: 'active',
          created_at: memberConnectedAt,
          expires_at: new Date(Date.now() + 57 * 60_000).toISOString(),
          refresh_count: 0,
          refresh_token: 'ciphertext',
        },
        {
          user_id: 'user-1',
          status: 'needs_reconsent',
          created_at: '2026-09-20T04:00:46Z',
          expires_at: '2026-09-20T05:00:46Z',
          refresh_count: 2,
          refresh_token: 'ciphertext',
        },
      ],
    }))
    const result = (await tool().execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' })) as {
      skatteverket_connection?: {
        status: string
        connected_at?: string | null
        filing?: { ready: boolean; own_session: string; message?: string }
      }
    }
    expect(result.skatteverket_connection).toMatchObject({
      status: 'active',
      connected_at: memberConnectedAt,
      filing: { ready: false, own_session: 'expired' },
    })
    expect(result.skatteverket_connection?.filing?.message).toContain('Anna Admin')
    expect(result.skatteverket_connection?.filing?.message).toContain('gnubok_connect_skatteverket')
  })

  it('reports needs_reconsent with the directive message so the agent warns the user up front', async () => {
    const supabase = withServiceReads(mockSupabase({
      profile: null,
      skvTokenRows: [
        { user_id: 'user-1', status: 'needs_reconsent', created_at: '2026-08-25T08:00:00Z' },
      ],
    }))
    const result = (await tool().execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      skatteverket_connection?: { status: string; source: string; message?: string }
    }
    expect(result.skatteverket_connection).toMatchObject({
      status: 'needs_reconsent',
      source: 'user',
    })
    expect(result.skatteverket_connection?.message).toContain('BankID')
    expect(result.skatteverket_connection?.message).toContain('tio timmar')
  })

  it('declares the block in the outputSchema as optional (never required)', () => {
    const output = tool().outputSchema as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(output.properties.skatteverket_connection).toBeDefined()
    expect(output.required).not.toContain('skatteverket_connection')
  })
})

describe('recommended_tools workflow loadouts (issue #1098)', () => {
  it('every tool name in every loadout exists in the actual tool registry (drift guard)', () => {
    const known = new Set(tools.map((t) => t.name))
    for (const loadout of RECOMMENDED_WORKFLOW_LOADOUTS) {
      const unknown = loadout.tools.filter((name) => !known.has(name))
      expect(unknown, `workflow "${loadout.workflow}" references unknown tools`).toEqual([])
    }
  })

  it('every loadout skill slug exists in the workflow-skill registry', () => {
    const slugs = new Set(workflowSkills.map((s) => s.slug))
    for (const loadout of RECOMMENDED_WORKFLOW_LOADOUTS) {
      expect(slugs.has(loadout.skill), `workflow "${loadout.workflow}" skill "${loadout.skill}"`).toBe(true)
    }
  })

  // Agent feedback seq 841832: bookkeep (#2982) shipped with no loadout and
  // categorize_month kept naming bank-reconciliation. A new workflow skill now
  // has to be named by a loadout or listed, with a reason, as having none.
  it('every workflow skill is named by a loadout or sits on the explicit no-loadout list', () => {
    const named = new Set(RECOMMENDED_WORKFLOW_LOADOUTS.map((l) => l.skill))
    const unaccounted = workflowSkills
      .filter((s) => s.itemKind !== 'analysis')
      .map((s) => s.slug)
      .filter((slug) => !named.has(slug) && !(slug in WORKFLOW_SKILLS_WITHOUT_LOADOUT))
    expect(
      unaccounted,
      'name these skills in a loadout or add them to WORKFLOW_SKILLS_WITHOUT_LOADOUT (recommended-tools.ts) with a reason',
    ).toEqual([])
  })

  it('the no-loadout list holds only real workflow skills that no loadout names', () => {
    const slugs = new Set(workflowSkills.map((s) => s.slug))
    const named = new Set(RECOMMENDED_WORKFLOW_LOADOUTS.map((l) => l.skill))
    for (const [slug, reason] of Object.entries(WORKFLOW_SKILLS_WITHOUT_LOADOUT)) {
      expect(slugs.has(slug), `${slug} is not a workflow skill`).toBe(true)
      expect(named.has(slug), `${slug} is named by a loadout; drop it from the list`).toBe(false)
      expect(reason.length, slug).toBeGreaterThan(0)
    }
  })

  it('categorize_month names bookkeep and the underlag and bulk tools that skill uses', () => {
    const categorize = RECOMMENDED_WORKFLOW_LOADOUTS.find((l) => l.workflow === 'categorize_month')!
    expect(categorize.skill).toBe('bookkeep')
    const bookkeep = workflowSkills.find((s) => s.slug === 'bookkeep')!
    for (const name of [
      'gnubok_list_unmatched_documents',
      'gnubok_get_document_content',
      'gnubok_bulk_book_transactions',
      'gnubok_attach_document_to_transaction',
    ]) {
      expect(categorize.tools, name).toContain(name)
      expect(bookkeep.body, name).toContain(name)
    }
  })

  it('workflow keys are unique, stable snake_case, and loadouts are non-empty with a description', () => {
    const keys = RECOMMENDED_WORKFLOW_LOADOUTS.map((w) => w.workflow)
    expect(new Set(keys).size).toBe(keys.length)
    for (const loadout of RECOMMENDED_WORKFLOW_LOADOUTS) {
      expect(loadout.workflow).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(loadout.description.length).toBeGreaterThan(0)
      expect(loadout.tools.length).toBeGreaterThan(0)
      // No duplicate tool names within a single loadout.
      expect(new Set(loadout.tools).size).toBe(loadout.tools.length)
    }
  })

  it('assertRecommendedLoadoutsValid throws on a tool name missing from the registry', () => {
    const known = new Set(tools.map((t) => t.name))
    known.delete('gnubok_categorize_transaction')
    expect(() => assertRecommendedLoadoutsValid(known)).toThrow(
      /categorize_month.*unknown tool "gnubok_categorize_transaction"/
    )
  })

  it('assertRecommendedLoadoutsValid passes against the real registry (mirrors the module-init guard)', () => {
    expect(() => assertRecommendedLoadoutsValid(new Set(tools.map((t) => t.name)))).not.toThrow()
  })

  it('the briefing returns recommended_tools with the expected shape, even for an empty company', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as {
      recommended_tools: Array<{
        workflow: string
        description: string
        skill: string
        tools: RecommendedToolEntry[]
      }>
    }
    expect(Array.isArray(result.recommended_tools)).toBe(true)
    expect(result.recommended_tools.length).toBe(RECOMMENDED_WORKFLOW_LOADOUTS.length)
    for (const entry of result.recommended_tools) {
      expect(typeof entry.workflow).toBe('string')
      expect(typeof entry.description).toBe('string')
      expect(typeof entry.skill).toBe('string')
      expect(Array.isArray(entry.tools)).toBe(true)
      expect(entry.tools.every((t) => typeof t.name === 'string' && typeof t.callable === 'boolean')).toBe(true)
    }
    // The static list is returned verbatim, in registry order.
    expect(result.recommended_tools.map((w) => w.workflow)).toEqual(
      RECOMMENDED_WORKFLOW_LOADOUTS.map((w) => w.workflow)
    )
  })

  it('the briefing outputSchema declares recommended_tools as required', () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const output = tool.outputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(output.properties.recommended_tools).toBeDefined()
    expect(output.required).toContain('recommended_tools')
  })

  it('the briefing description advertises the loadout and the one-call batch-load pattern', () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    expect(tool.description).toContain('recommended_tools')
    expect(tool.description).toContain('ToolSearch')
  })
})

// Feedback seq 372962 (and the 08-26 recurrence): a key without
// reconciliation:* scopes was handed the reconcile_month loadout and every
// call failed on scope; the search-only writes in it were reported as missing
// tools four times (335021 / 381082 / 414922 / 371965). The loadout stays
// static and complete; each tool now says whether THIS key on a
// tools/list-only client can call it, and why not. Deliberately NOT asserted:
// that every loadout tool is in the default catalog. Four are search-only by
// design (tools/list has single-digit token headroom); the flag replaces
// promotion.
describe('recommended_tools callability (feedback seq 372962)', () => {
  const tool = () => tools.find((t) => t.name === 'gnubok_get_agent_briefing')!

  /** Mirrors the dispatcher: inject __keyScopes the way handleMcpRequest does. */
  async function briefing(keyScopes?: readonly string[]) {
    const supabase = mockSupabase({ profile: null })
    const args = keyScopes ? { __keyScopes: [...keyScopes] } : {}
    const result = (await tool().execute(args, 'company-1', 'user-1', supabase as never, {
      type: 'api_key',
    })) as { recommended_tools: Array<{ workflow: string; tools: RecommendedToolEntry[] }> }
    return result.recommended_tools
  }
  const loadout = (all: Array<{ workflow: string; tools: RecommendedToolEntry[] }>, workflow: string) =>
    all.find((w) => w.workflow === workflow)!.tools
  const entry = (list: RecommendedToolEntry[], name: string) => list.find((t) => t.name === name)!

  it('a key without reconciliation scopes gets the reconcile_month tools flagged blocked_by scope, naming the scope', async () => {
    // DEFAULT_OAUTH_SCOPES is the read-only grant an OAuth connector gets when
    // it asks for nothing explicit: no reconciliation:* member.
    expect(DEFAULT_OAUTH_SCOPES.some((s) => s.startsWith('reconciliation:'))).toBe(false)
    const reconcile = loadout(await briefing(DEFAULT_OAUTH_SCOPES), 'reconcile_month')

    for (const [name, scope] of [
      ['gnubok_list_reconciliation_items', 'reconciliation:read'],
      ['gnubok_reconcile_match', 'reconciliation:write'],
      ['gnubok_reconcile_unmatch', 'reconciliation:write'],
      ['gnubok_reconcile_signoff', 'reconciliation:signoff'],
    ] as const) {
      const e = entry(reconcile, name)
      expect(e, name).toMatchObject({ callable: false, blocked_by: 'scope' })
      expect(e.note, name).toContain(`requires ${scope}`)
    }
    // reports:read IS in the default grant, so the status read stays callable.
    expect(entry(reconcile, 'gnubok_get_reconciliation_status')).toEqual({
      name: 'gnubok_get_reconciliation_status',
      callable: true,
    })
  })

  it('with every scope granted, the search-only reconciliation WRITES are callable through gnubok_stage_tool (issue #2800)', async () => {
    // These four were blocked_by "catalog" until #2800, and they are the ones
    // customers were stuck on: an auto-applied skattekonto match could not be
    // undone, and a reconciliation gap blocked a second SIE import.
    const reconcile = loadout(await briefing(ALL_SCOPES), 'reconcile_month')
    const SEARCH_ONLY_RECONCILE_WRITES = [
      'gnubok_reconcile_unmatch',
      'gnubok_reconcile_residual',
      'gnubok_reconcile_signoff',
      'gnubok_link_transaction_to_journal_entry',
    ]

    for (const name of SEARCH_ONLY_RECONCILE_WRITES) {
      const registryTool = tools.find((t) => t.name === name)!
      expect(isDefaultCatalogTool(registryTool), name).toBe(false)
      expect(registryTool.annotations.readOnlyHint, name).not.toBe(true)
      const e = entry(reconcile, name)
      expect(e.callable, name).toBe(true)
      expect(e.blocked_by, name).toBeUndefined()
      expect(e.note, name).toContain('not in tools/list')
      expect(e.note, name).toContain('gnubok_stage_tool')
      expect(e.note, name).toContain('gnubok_approve_pending_operation')
    }

    // Reach never overrides scope: the bridge enforces the inner tool's scope,
    // so the briefing must not call these callable for a key that lacks it.
    const readOnly = loadout(await briefing(['agent:read', 'reports:read', 'reconciliation:read']), 'reconcile_month')
    for (const name of SEARCH_ONLY_RECONCILE_WRITES) {
      expect(entry(readOnly, name), name).toMatchObject({ callable: false, blocked_by: 'scope' })
    }
    for (const name of [
      'gnubok_get_reconciliation_status',
      'gnubok_reconcile_match',
      'gnubok_categorize_transaction',
      'gnubok_ignore_transaction',
      'gnubok_approve_pending_operation',
    ]) {
      expect(entry(reconcile, name), name).toEqual({ name, callable: true })
    }
  })

  it('keeps every loadout complete (nothing dropped) and lists callable tools first', async () => {
    for (const keyScopes of [ALL_SCOPES, DEFAULT_OAUTH_SCOPES, [] as string[]]) {
      const all = await briefing(keyScopes)
      for (const w of RECOMMENDED_WORKFLOW_LOADOUTS) {
        const returned = loadout(all, w.workflow)
        expect([...returned.map((t) => t.name)].sort()).toEqual([...w.tools].sort())
        const firstBlocked = returned.findIndex((t) => !t.callable)
        if (firstBlocked >= 0) {
          expect(returned.slice(firstBlocked).every((t) => !t.callable)).toBe(true)
        }
        for (const t of returned) {
          if (t.callable) expect(t.blocked_by).toBeUndefined()
          else expect(['scope', 'catalog']).toContain(t.blocked_by)
        }
      }
    }
  })

  it('every default-catalog tool with a granted scope is callable: the flag is never pessimistic by accident', async () => {
    const all = await briefing(ALL_SCOPES)
    for (const w of RECOMMENDED_WORKFLOW_LOADOUTS) {
      for (const t of loadout(all, w.workflow)) {
        const registryTool = tools.find((r) => r.name === t.name)!
        if (isDefaultCatalogTool(registryTool)) expect(t.callable, t.name).toBe(true)
      }
    }
  })

  it('fail-closed: without the injected __keyScopes marker every scoped tool is reported blocked_by scope', async () => {
    // Same contract as gnubok_search_tools: a direct execute() outside the
    // dispatcher must not vouch for a scoped tool on faith.
    const all = await briefing(undefined)
    for (const w of RECOMMENDED_WORKFLOW_LOADOUTS) {
      for (const t of loadout(all, w.workflow)) {
        const required = TOOL_SCOPE_MAP[t.name]
        if (required) expect(t, t.name).toMatchObject({ callable: false, blocked_by: 'scope' })
      }
    }
  })

  it('annotateLoadoutTools: a missing scope wins over the catalog reason, a search-only READ stays callable with a bridge note', () => {
    const classify = (name: string) =>
      ({
        write_no_scope: { required_scope: 'x:write', callable_via: 'none' as const },
        write_scoped: { required_scope: 'x:write', callable_via: 'none' as const },
        read_search_only: { required_scope: null, callable_via: 'call_tool' as const },
        plain: { required_scope: null, callable_via: 'tools_list' as const },
      })[name]!
    const result = annotateLoadoutTools(
      ['write_no_scope', 'plain', 'write_scoped', 'read_search_only'],
      classify,
      new Set(['y:read']),
    )
    expect(result.map((t) => t.name)).toEqual(['plain', 'read_search_only', 'write_no_scope', 'write_scoped'])
    expect(result[0]).toEqual({ name: 'plain', callable: true })
    expect(result[1]).toMatchObject({ name: 'read_search_only', callable: true })
    expect(result[1].note).toContain('gnubok_call_tool')
    expect(result[2]).toMatchObject({ callable: false, blocked_by: 'scope', note: 'requires x:write: not granted to this API key' })
    expect(result[3]).toMatchObject({ callable: false, blocked_by: 'scope' })
    // Grant the scope: the catalog reason surfaces.
    const granted = annotateLoadoutTools(['write_scoped'], classify, new Set(['x:write']))
    expect(granted[0]).toMatchObject({ callable: false, blocked_by: 'catalog' })
  })

  it('annotateLoadoutTools: a narrow scope is met by the broader grant including it (crm#1548)', () => {
    const classify = () => ({ required_scope: 'invoices:draft', callable_via: 'tools_list' as const })
    expect(annotateLoadoutTools(['gnubok_create_invoice'], classify, new Set(['invoices:write']))[0]).toEqual({
      name: 'gnubok_create_invoice',
      callable: true,
    })
    expect(annotateLoadoutTools(['gnubok_create_invoice'], classify, new Set(['invoices:draft']))[0].callable).toBe(true)
    expect(annotateLoadoutTools(['gnubok_create_invoice'], classify, new Set(['invoices:read']))[0]).toMatchObject({
      callable: false,
      blocked_by: 'scope',
    })
  })
})
