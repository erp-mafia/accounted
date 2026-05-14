import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_uncategorized_transactions')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_list_uncategorized_transactions', () => {
  it('is registered as a read-only paginated tool', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as Record<string, unknown>
    expect((schema.properties as Record<string, unknown>).transactions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).total_count).toBeDefined()
  })

  it('returns rows when DB has null merchant_name, reference, is_business (MCP structured output)', async () => {
    const rows = [
      {
        id: 't-uncat-1',
        date: '2026-03-09',
        description: 'Transfer',
        amount: -6000,
        currency: 'SEK',
        merchant_name: null,
        reference: null,
        is_business: null,
        category: null,
      },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 1 })
    enqueue({ data: rows, error: null })

    const result = (await tool.execute(
      { limit: 20 },
      'company-1',
      'user-1',
      supabase as never
    )) as {
      transactions: typeof rows
      count: number
      total_count: number
      has_more: boolean
    }

    expect(result.count).toBe(1)
    expect(result.transactions[0].merchant_name).toBeNull()
    expect(result.transactions[0].reference).toBeNull()
    expect(result.transactions[0].is_business).toBeNull()
  })
})
