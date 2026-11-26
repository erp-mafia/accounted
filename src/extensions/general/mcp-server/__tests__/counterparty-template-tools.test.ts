/**
 * The learned booking rules (counterparty templates) over MCP: the list read,
 * which can now show paused rules so an agent can resume one, and the two
 * staged writes generated from src/lib/operations/counterparty-templates.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { tools, isDefaultCatalogTool } from '../server'

const TEMPLATE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const RULE = {
  id: TEMPLATE_ID,
  counterparty_name: 'hallon ab 4471',
  counterparty_aliases: [],
  debit_account: '6211',
  credit_account: '1930',
  is_active: true,
  mode: 'propose',
  always_review: false,
}

const tool = (name: string) => tools.find((t) => t.name === name)!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('counterparty template tools', () => {
  it('exist search-only, scoped like the registry, writes staging', () => {
    for (const [name, scope] of [
      ['gnubok_get_counterparty_templates', 'transactions:read'],
      ['gnubok_rename_counterparty_template', 'bookkeeping:write'],
      ['gnubok_update_counterparty_template', 'bookkeeping:write'],
    ] as const) {
      expect(tool(name), name).toBeDefined()
      expect(isDefaultCatalogTool(tool(name)), name).toBe(false)
      expect(TOOL_SCOPE_MAP[name], name).toBe(scope)
    }
    expect(tool('gnubok_update_counterparty_template').description).toMatch(/\bStage\b/)
  })

  it('lists only active templates by default, with each one\'s mode', async () => {
    const { supabase, enqueue, findCalls, findCall } = createQueuedMockSupabase()
    enqueue({ data: [RULE], error: null })

    const result = (await tool('gnubok_get_counterparty_templates').execute({}, 'company-1', 'user-1', supabase as never)) as {
      templates: Array<Record<string, unknown>>
    }

    expect(findCalls('categorization_templates', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_active', true],
    ])
    expect(String(findCall('categorization_templates', 'select')?.[0])).toContain('mode, always_review')
    expect(result.templates[0]).toMatchObject({ id: TEMPLATE_ID, mode: 'propose', counterparty_name_display: 'Hallon AB 4471' })
  })

  it('lists paused templates too with include_paused, still within the company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ ...RULE, is_active: false, mode: 'paused' }], error: null })

    const result = (await tool('gnubok_get_counterparty_templates').execute(
      { include_paused: true },
      'company-1',
      'user-1',
      supabase as never,
    )) as { templates: Array<Record<string, unknown>> }

    expect(findCalls('categorization_templates', 'eq')).toEqual([['company_id', 'company-1']])
    expect(result.templates[0]).toMatchObject({ mode: 'paused' })
  })

  it('narrows by name with query, as a stored key with LIKE wildcards escaped', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ ...RULE, is_active: false, mode: 'paused' }], error: null })

    await tool('gnubok_get_counterparty_templates').execute(
      { include_paused: true, query: '  Hallon   100%_AB ' },
      'company-1',
      'user-1',
      supabase as never,
    )

    expect(findCalls('categorization_templates', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('categorization_templates', 'ilike')).toEqual([
      ['counterparty_name', '%hallon 100\\%\\_ab%'],
    ])
  })

  it('adds no name filter for an empty query', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [RULE], error: null })

    await tool('gnubok_get_counterparty_templates').execute({ query: '   ' }, 'company-1', 'user-1', supabase as never)

    expect(findCalls('categorization_templates', 'ilike')).toEqual([])
  })

  it('stages pausing a rule with a Swedish title that names it, and writes nothing else', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: RULE, error: null }) // the rule (dry run)
    enqueue({ data: { id: 'op-rule-1' }, error: null }) // pending_operations insert

    const result = (await tool('gnubok_update_counterparty_template').execute(
      { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({ mode_before: 'propose', mode_after: 'paused', debit_account: '6211' })
    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      operation_type: 'update_counterparty_template',
      title: 'Pausa regeln för Hallon AB 4471',
      params: { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
    })
    expect(findCall('categorization_templates', 'update')).toBeUndefined()
  })

  it('refuses to stage a change to a rule the company does not have', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    await expect(
      tool('gnubok_update_counterparty_template').execute(
        { counterparty_template_id: TEMPLATE_ID, mode: 'paused' },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'COUNTERPARTY_TEMPLATE_NOT_FOUND' })
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })
})
