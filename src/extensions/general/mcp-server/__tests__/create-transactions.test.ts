import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The approval stores each row through ingestTransactions; the staging asks
// the same dedup decision first (previewIngestDedup).
vi.mock('@/lib/transactions/dedup-preview', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transactions/dedup-preview')>('@/lib/transactions/dedup-preview')
  return { ...actual, previewIngestDedup: vi.fn() }
})

import { tools } from '../server'
import { previewIngestDedup } from '@/lib/transactions/dedup-preview'

const tool = tools.find((t) => t.name === 'gnubok_create_transactions')!
const mockPreview = vi.mocked(previewIngestDedup)

const NOT_STORED = {
  external_id: 'x',
  would_skip: false,
  skip_reason: null,
  matched_external_id: null,
  matched_transaction_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPreview.mockResolvedValue([NOT_STORED])
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
    // Neither row names ledger_account: the dedup preview reads each row's default account first.
    enqueue({ data: [], error: null }) // row 1: default cash account
    enqueue({ data: [], error: null }) // row 2: default cash account
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

  it('asks the ingest dedup per row with the commit\'s fields and settlement account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { currency: 'EUR' }, error: null }) // the kassakonto on 1935: in the row's currency
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    await tool.execute(
      { transactions: [{ date: '2026-05-01', amount: -50, description: 'Wise', currency: 'eur', ledger_account: '1935' }] },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )

    expect(mockPreview).toHaveBeenCalledWith(
      supabase,
      'company-1',
      [expect.objectContaining({ date: '2026-05-01', amount: -50, description: 'Wise', currency: 'EUR', import_source: 'mcp' })],
      { settlementAccount: '1935' },
    )
  })

  // The approval refuses a row on a ledger whose kassakonto holds another
  // currency (CASH_ACCOUNT_CURRENCY_MISMATCH); staging says so first, so no
  // proposal is made that cannot be approved.
  it('refuses a row in another currency than the kassakonto on its ledger_account, staging nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { currency: 'EUR' }, error: null }) // row 0: the kassakonto on 1948, EUR as well
    enqueue({ data: { currency: 'EUR' }, error: null }) // row 1: the same kassakonto, but the row is GBP

    const error = await tool
      .execute(
        {
          transactions: [
            { date: '2026-11-20', amount: -10, description: 'Kortköp Paris', currency: 'EUR', ledger_account: '1948' },
            { date: '2026-11-20', amount: -42.5, description: 'Kortköp London', currency: 'GBP', ledger_account: '1948' },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      )
      .catch((err: unknown) => err)

    expect(error).toMatchObject({ code: 'CASH_ACCOUNT_CURRENCY_MISMATCH' })
    expect(String((error as Error).message)).toMatch(/transactions\[1\].*1948 is in EUR, not GBP/)
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['ledger_account', '1948'])
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('does not read a kassakonto for a company card: the approval checks the card', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    await tool.execute(
      { transactions: [{ date: '2026-05-01', amount: -349, description: 'Molnkontoret AB', currency: 'SEK', ledger_account: '2890' }] },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )

    expect(findCalls('cash_accounts', 'eq')).toHaveLength(0)
  })

  it('without ledger_account, previews on the default account the commit settles on (crm#1171)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'ca-eur', ledger_account: '1932', is_primary: false, bank_connection_id: null }], error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { id: 'op-1' }, error: null })

    await tool.execute(
      { transactions: [{ date: '2026-05-01', amount: -50, description: 'Card', currency: 'eur' }] },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' },
    )

    expect(findCalls('cash_accounts', 'eq')).toEqual([['company_id', 'company-1'], ['enabled', true], ['kind', 'bank'], ['currency', 'EUR']])
    expect(mockPreview).toHaveBeenCalledWith(supabase, 'company-1', [expect.objectContaining({ currency: 'EUR' })], {
      settlementAccount: '1932',
    })
  })

  it('refuses with TX_CREATE_DUPLICATE, staging nothing, when a row is already stored', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    mockPreview
      .mockResolvedValueOnce([NOT_STORED])
      .mockResolvedValueOnce([
        {
          external_id: 'mcp:staging-preview',
          would_skip: true,
          skip_reason: 'content_match_unbooked',
          matched_external_id: 'eb-77',
          matched_transaction_id: 'tx-feed-1',
        },
      ])

    const error = await tool
      .execute(
        {
          transactions: [
            { date: '2026-05-01', amount: 100, description: 'Inflow' },
            { date: '2026-05-02', amount: -50, description: 'Card' },
          ],
        },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' },
      )
      .catch((err: unknown) => err)

    expect(error).toMatchObject({ code: 'TX_CREATE_DUPLICATE' })
    expect(String((error as Error).message)).toMatch(/transactions\[1\].*tx-feed-1/)
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
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
