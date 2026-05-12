import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_list_transactions_without_documents')!

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_list_transactions_without_documents', () => {
  it('is registered as a read-only paginated tool', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as Record<string, unknown>
    expect((schema.properties as Record<string, unknown>).transactions).toBeDefined()
    expect((schema.properties as Record<string, unknown>).total_count).toBeDefined()
  })

  it('returns booked transactions that have no document attached', async () => {
    const rows = [
      {
        id: 't1',
        date: '2026-04-12',
        description: 'HOTELL ANGLAIS',
        amount: -1247,
        currency: 'SEK',
        merchant_name: 'Hotell Anglais',
        reference: null,
        is_business: true,
        category: 'travel',
        journal_entry_id: 'je-1',
      },
    ]
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 1 }) // count query
    enqueue({ data: rows, error: null }) // data query

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
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.transactions[0].id).toBe('t1')
    expect(result.transactions[0].journal_entry_id).toBe('je-1')
  })

  it('returns rows when DB has null merchant_name, reference, is_business, category (MCP structured output)', async () => {
    const rows = [
      {
        id: 't-no-doc-1',
        date: '2026-03-17',
        description: 'Nolla skuld',
        amount: -2745,
        currency: 'SEK',
        merchant_name: null,
        reference: null,
        is_business: null,
        category: null,
        journal_entry_id: 'je-nolla-1',
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
    expect(result.transactions[0].journal_entry_id).toBe('je-nolla-1')
    expect(result.transactions[0].merchant_name).toBeNull()
    expect(result.transactions[0].reference).toBeNull()
    expect(result.transactions[0].is_business).toBeNull()
    expect(result.transactions[0].category).toBeNull()
  })

  it('returns empty result when nothing matches', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 0 })
    enqueue({ data: [], error: null })

    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never
    )) as { count: number; total_count: number; has_more: boolean }

    expect(result.count).toBe(0)
    expect(result.total_count).toBe(0)
    expect(result.has_more).toBe(false)
  })

  it('signals more pages with next_offset when total exceeds the page', async () => {
    const page = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      date: '2026-04-01',
      description: 'tx',
      amount: -100,
      currency: 'SEK',
      merchant_name: null,
      reference: null,
      is_business: true,
      category: null,
      journal_entry_id: `je-${i}`,
    }))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null, count: 50 })
    enqueue({ data: page, error: null })

    const result = (await tool.execute(
      { limit: 20, offset: 0 },
      'company-1',
      'user-1',
      supabase as never
    )) as { has_more: boolean; next_offset?: number }

    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(20)
  })

  it('throws on database errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection refused' }, count: null })

    await expect(
      tool.execute({}, 'company-1', 'user-1', supabase as never)
    ).rejects.toThrow(/connection refused/)
  })
})
