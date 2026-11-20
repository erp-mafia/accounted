/**
 * Account dimension rules over MCP: the tools generated from
 * src/lib/operations/dimension-rules.ts. Reads run directly, writes stage a
 * pending operation after a dry run that refuses what could never commit.
 * Also the retag log read generated from src/lib/operations/dimension-retag.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { tools, isDefaultCatalogTool } from '../server'

const DIM_ID = '0e9c0000-0000-4000-8000-000000000006'
const RULE_ID = '5b7e0000-0000-4000-8000-000000000001'

const tool = (name: string) => tools.find((t) => t.name === name)!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dimension rule tools', () => {
  it('exist search-only, scoped like the registry, writes staging', () => {
    for (const [name, scope] of [
      ['gnubok_list_dimension_rules', 'reports:read'],
      ['gnubok_create_dimension_rule', 'bookkeeping:write'],
      ['gnubok_update_dimension_rule', 'bookkeeping:write'],
      ['gnubok_delete_dimension_rule', 'bookkeeping:write'],
    ] as const) {
      expect(tool(name), name).toBeDefined()
      expect(isDefaultCatalogTool(tool(name)), name).toBe(false)
      expect(TOOL_SCOPE_MAP[name]).toBe(scope)
    }
    expect(tool('gnubok_create_dimension_rule').description).toMatch(/\bStage\b/)
  })

  it('lists the rules of one account', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: RULE_ID,
          account_number: '4010',
          rule_type: 'required',
          value_id: null,
          is_active: true,
          dimension: { id: DIM_ID, sie_dim_no: 6, name: 'Projekt' },
          value: null,
        },
      ],
      error: null,
    })

    const result = (await tool('gnubok_list_dimension_rules').execute(
      { account_number: '4010' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { rules: Array<Record<string, unknown>> }

    expect(result.rules).toEqual([
      expect.objectContaining({ account_dimension_rule_id: RULE_ID, sie_dim_no: 6, rule_type: 'required' }),
    ])
    expect(findCalls('account_dimension_rules', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['account_number', '4010'],
    ])
  })

  it('refuses to stage a second rule for the same account and dimension', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: DIM_ID, is_active: true }, error: null }) // dimension
    enqueue({ data: { account_number: '4010' }, error: null }) // chart
    enqueue({ data: { id: RULE_ID }, error: null }) // the existing rule (dry run)

    await expect(
      tool('gnubok_create_dimension_rule').execute(
        { account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'DIMENSION_RULE_EXISTS' })
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })

  it('stages a new rule with the input as params and a Swedish title', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: DIM_ID, is_active: true }, error: null }) // dimension
    enqueue({ data: { account_number: '4010' }, error: null }) // chart
    enqueue({ data: null, error: null }) // no rule yet (dry run)
    enqueue({ data: { id: 'op-rule-1' }, error: null }) // pending_operations insert

    const result = (await tool('gnubok_create_dimension_rule').execute(
      { account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({ account_number: '4010', rule_type: 'required', value_id: null })
    const insert = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(insert).toMatchObject({
      operation_type: 'create_dimension_rule',
      title: 'Dimensionsregel för konto 4010: obligatorisk',
      params: { account_number: '4010', dimension_id: DIM_ID, rule_type: 'required' },
    })
  })
})

describe('gnubok_list_dimension_retag_log', () => {
  it('is a search-only read over the same log read as v1, scoped to the company', async () => {
    const logTool = tool('gnubok_list_dimension_retag_log')
    expect(logTool).toBeDefined()
    expect(isDefaultCatalogTool(logTool)).toBe(false)
    expect(TOOL_SCOPE_MAP.gnubok_list_dimension_retag_log).toBe('reports:read')

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: RULE_ID,
          journal_entry_id: DIM_ID,
          line_id: DIM_ID,
          old_dimensions: {},
          new_dimensions: { '6': 'P001' },
          actor: null,
          reason: 'Retro-taggning',
          created_at: '2026-09-28T09:14:00Z',
        },
      ],
      error: null,
      count: 1,
    })

    const result = (await logTool.execute({ line_id: DIM_ID }, 'company-1', 'user-1', supabase as never)) as {
      entries: Array<Record<string, unknown>>
      total_count: number
      has_more: boolean
    }

    expect(result.entries[0]).toMatchObject({ retag_log_id: RULE_ID, new_dimensions: { '6': 'P001' } })
    expect(result.entries[0]).not.toHaveProperty('id')
    expect(result).toMatchObject({ total_count: 1, has_more: false })
    expect(findCalls('dimension_retag_log', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['line_id', DIM_ID],
    ])
    expect(findCalls('dimension_retag_log', 'range')).toEqual([[0, 49]])
  })
})
