import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_create_transactions')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_create_transactions', () => {
  it('is registered with a stage-style outputSchema', () => {
    expect(tool).toBeDefined()
    const schema = tool.outputSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect((schema.properties as Record<string, unknown>).operations).toBeDefined()
  })

  it('stages one pending_operation per input item and returns operation ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Each staged op now also runs resolvePeriodStatusForDate (company_settings + fiscal_periods).
    enqueue({ data: null, error: null }) // op 1: company_settings
    enqueue({ data: null, error: null }) // op 1: fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // first insert
    enqueue({ data: null, error: null }) // op 2: company_settings
    enqueue({ data: null, error: null }) // op 2: fiscal_periods
    enqueue({ data: { id: 'op-2' }, error: null }) // second insert

    const result = (await tool.execute(
      {
        transactions: [
          { date: '2026-05-01', amount: 100, description: 'Inflow', external_id: 'rec1' },
          { date: '2026-05-02', amount: -50, description: 'Outflow', currency: 'EUR' },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' }
    )) as { staged_count: number; operations: Array<{ operation_id: string; risk_level: string }> }

    expect(result.staged_count).toBe(2)
    expect(result.operations).toHaveLength(2)
    expect(result.operations[0].operation_id).toBe('op-1')
    expect(result.operations[1].operation_id).toBe('op-2')
    expect(result.operations[0].risk_level).toBe('medium')
  })

  it('rejects empty arrays', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute({ transactions: [] }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/non-empty array/)
  })

  it('rejects more than 10 transactions per call', async () => {
    const { supabase } = createQueuedMockSupabase()
    const items = Array.from({ length: 11 }, (_, i) => ({
      date: '2026-05-01',
      amount: i,
      description: `tx ${i}`,
    }))
    await expect(
      tool.execute({ transactions: items }, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/per-call limit of 10/)
  })

  it('rejects items with malformed dates', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute(
        {
          transactions: [{ date: '01/05/2026', amount: 1, description: 'x' }],
        },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/YYYY-MM-DD/)
  })

  it('rejects items with non-finite amounts', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute(
        {
          transactions: [{ date: '2026-05-01', amount: 'NaN', description: 'x' }],
        },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/finite number/)
  })

  it('rejects items with empty descriptions', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool.execute(
        {
          transactions: [{ date: '2026-05-01', amount: 1, description: '   ' }],
        },
        'company-1',
        'user-1',
        supabase as never
      )
    ).rejects.toThrow(/description is required/)
  })
})
