import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

/**
 * The tool is a thin wrapper over the transactions_without_documents RPC:
 * the bank-driven subset of the verifikat surface, keyed on the SAME document
 * truth (document_attachments + waivers), never transactions.document_id.
 * Predicate semantics are pinned by
 * tests/pg/document-surfaces-unification.pg.test.ts; these tests cover the
 * wrapper contract (envelope unwrap, pagination math, error paths).
 */
const tool = tools.find((t) => t.name === 'gnubok_list_transactions_without_documents')!

function envelope(transactions: unknown[], totalCount: number) {
  return { data: { ok: true, total_count: totalCount, transactions }, error: null }
}

const row = (id: string, jeId: string) => ({
  id,
  transaction_id: id,
  date: '2026-04-12',
  description: 'HOTELL ANGLAIS',
  amount: -1247,
  currency: 'SEK',
  merchant_name: null,
  reference: null,
  is_business: null,
  category: null,
  journal_entry_id: jeId,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_list_transactions_without_documents', () => {
  it('is registered as a read-only paginated tool with qualified transaction_id', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as { properties: Record<string, unknown> }
    expect(schema.properties.transactions).toBeDefined()
    expect(schema.properties.total_count).toBeDefined()
    const items = (schema.properties.transactions as { items: { properties: Record<string, unknown> } })
      .items
    expect(items.properties.transaction_id).toBeDefined()
    expect(items.properties.journal_entry_id).toBeDefined()
  })

  it('unwraps the RPC envelope and passes filters through', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(envelope([row('t1', 'je-1')], 1))

    const result = (await tool.execute(
      { limit: 20, since: '2026-01-01' },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      transactions: Array<{ id: string; transaction_id: string; journal_entry_id: string }>
      count: number
      total_count: number
      has_more: boolean
    }

    expect(supabase.rpc).toHaveBeenCalledWith('transactions_without_documents', {
      p_company_id: 'company-1',
      p_since: '2026-01-01',
      p_limit: 20,
      p_offset: 0,
    })
    expect(result.count).toBe(1)
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.transactions[0].transaction_id).toBe('t1')
    expect(result.transactions[0].journal_entry_id).toBe('je-1')
  })

  it('returns empty result when nothing matches', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(envelope([], 0))

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as {
      count: number
      total_count: number
      has_more: boolean
    }

    expect(result.count).toBe(0)
    expect(result.total_count).toBe(0)
    expect(result.has_more).toBe(false)
  })

  it('signals more pages with next_offset advancing by rows consumed', async () => {
    const page = Array.from({ length: 20 }, (_, i) => row(`t${i}`, `je-${i}`))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(envelope(page, 45))

    const result = (await tool.execute(
      { limit: 20 },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      has_more: boolean
      next_offset?: number
    }

    expect(result.has_more).toBe(true)
    expect(result.next_offset).toBe(20)
  })

  it('throws on an RPC error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection refused' } })

    await expect(tool.execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(
      /connection refused/,
    )
  })

  it('throws on a not-ok envelope (tenant guard)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ok: false, code: 'TRANSACTIONS_WITHOUT_DOCUMENTS_FORBIDDEN' }, error: null })

    await expect(tool.execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(
      /TRANSACTIONS_WITHOUT_DOCUMENTS_FORBIDDEN/,
    )
  })
})
