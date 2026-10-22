/**
 * listRules reads every rule (categorization_templates) of the company. One
 * company holds more than PostgREST's 1,000-row page (product issue #58), and
 * the Regler list ended at an arbitrary 1,000.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPagedMockSupabase, createQueuedMockSupabase, manyRows, POSTGREST_MAX_ROWS } from '@/tests/helpers'
import { listRules } from '../service'

const COMPANY_ID = 'company-1'

const rule = (i: number) => ({
  id: `rule-${i}`,
  counterparty_name: `leverantor ${i}`,
  counterparty_aliases: [],
  occurrence_count: 1,
  mode: 'propose',
  is_active: true,
})

describe('listRules', () => {
  it('returns every rule past the 1,000-row page, id breaking the occurrence and updated_at ties', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({ categorization_templates: manyRows(1200, rule) })

    const rules = await listRules(supabase as unknown as SupabaseClient, COMPANY_ID)

    expect(rules).toHaveLength(1200)
    expect(rules[1199].id).toBe('rule-1199')
    expect(findCalls('categorization_templates', 'range')).toEqual([
      [0, POSTGREST_MAX_ROWS - 1],
      [POSTGREST_MAX_ROWS, 2 * POSTGREST_MAX_ROWS - 1],
    ])
    expect(findCalls('categorization_templates', 'order').slice(0, 3).map((args) => args[0])).toEqual([
      'occurrence_count',
      'updated_at',
      'id',
    ])
  })

  it('reads the legacy columns, paged, on a database without the mode column', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '42703', message: 'column categorization_templates.mode does not exist' } })
    enqueue({ data: manyRows(1000, (i) => ({ ...rule(i), mode: undefined })) })
    enqueue({ data: [{ ...rule(1000), mode: undefined, is_active: false }] })

    const rules = await listRules(supabase as unknown as SupabaseClient, COMPANY_ID)

    expect(rules).toHaveLength(1001)
    expect(rules[0].mode).toBe('propose')
    expect(rules[1000].mode).toBe('paused')
  })

  it('throws any other read error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    await expect(listRules(supabase as unknown as SupabaseClient, COMPANY_ID)).rejects.toMatchObject({ code: '57014' })
  })
})
