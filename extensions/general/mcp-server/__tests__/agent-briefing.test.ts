/**
 * Tests for gnubok_get_agent_briefing — session-bootstrap context for the
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
  errors?: { profile?: string; memory?: string; atoms?: string }
}) {
  const profile = opts.profile === undefined ? null : opts.profile
  const memoryRows = opts.memoryRows ?? []
  const atomRows = opts.atomRows ?? []
  const errors = opts.errors ?? {}

  return {
    from: vi.fn((table: string) => {
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

  it('returns null summary, empty atoms, empty memory when no profile exists', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_agent_briefing')!
    const supabase = mockSupabase({ profile: null })
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
    expect(result.profile_summary).toBeNull()
    expect(result.atoms).toEqual([])
    expect(result.memory).toEqual([])
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
})
