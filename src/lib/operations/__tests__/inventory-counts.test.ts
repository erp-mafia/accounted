import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({ bookStockCount: vi.fn(), previewStockCountBooking: vi.fn() }))
vi.mock('@/lib/bokslut/stock-count/booking', () => ({
  bookStockCount: mocks.bookStockCount,
  previewStockCountBooking: mocks.previewStockCountBooking,
}))

import { inventoryCountsBook, inventoryCountsList, inventoryCountsSave } from '../inventory-counts'

const PERIOD = { id: '3f6c2a1e-8b4d-4c2e-9a71-5d0e6b7c8a90', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }
const COUNT_ID = '9d2f4c1a-6b3e-4f5a-8c7d-1e2f3a4b5c6d'

function ctx(mock: ReturnType<typeof createTableMockSupabase>) {
  return { supabase: mock.supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log: createLogger('test') }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', 'company-1')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('inventory-counts operations', () => {
  it('answer STOCK_COUNT_DISABLED for a company outside BOLAGET_COMPANY_IDS', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'someone-else')
    const outcome = await inventoryCountsList.run(ctx(createTableMockSupabase()), {}, { dryRun: false })
    expect(outcome).toEqual({ ok: false, code: 'STOCK_COUNT_DISABLED' })
  })

  it('stage a save with its valued rows and write nothing on the dry run', async () => {
    const mock = createTableMockSupabase({ fiscal_periods: { data: PERIOD } })
    const outcome = await inventoryCountsSave.run(
      ctx(mock),
      inventoryCountsSave.input.parse({
        fiscal_period_id: PERIOD.id,
        count_date: '2026-12-31',
        rows: [{ description: 'Kaffe', quantity: 10, unit_cost: 100, write_down_percent: 10 }],
      }),
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { balance_date: '2026-12-31', row_count: 1, rows: [{ value: 900 }] } })
    expect(mock.findCalls('inventory_counts', 'insert')).toEqual([])
  })

  it('refuse the dry run of a count off balansdagen without its roll-forward', async () => {
    const mock = createTableMockSupabase({ fiscal_periods: { data: PERIOD } })
    const outcome = await inventoryCountsSave.run(
      ctx(mock),
      inventoryCountsSave.input.parse({ fiscal_period_id: PERIOD.id, count_date: '2027-01-05', rows: [] }),
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'STOCK_COUNT_ROLL_FORWARD_REQUIRED' })
  })

  it('refuse to stage booking an unsigned count, and book a signed one on commit', async () => {
    const draft = createTableMockSupabase({ inventory_counts: { data: { id: COUNT_ID, status: 'draft' } } })
    expect(await inventoryCountsBook.run(ctx(draft), { inventory_count_id: COUNT_ID }, { dryRun: true })).toEqual({
      ok: false,
      code: 'STOCK_COUNT_NOT_SIGNED',
    })
    mocks.bookStockCount.mockResolvedValue({ count: { id: COUNT_ID }, entry: { id: 'je-1' }, preview: { adjustments: [] } })
    const outcome = await inventoryCountsBook.run(ctx(createTableMockSupabase()), { inventory_count_id: COUNT_ID }, { dryRun: false })
    expect(outcome).toEqual({ ok: true, data: { inventory_count_id: COUNT_ID, journal_entry_id: 'je-1', adjustments: [] } })
  })

  it('stage the book as high risk and the save as low, with their pending types', () => {
    expect(inventoryCountsBook.risk).toBe('high')
    expect(inventoryCountsBook.mcp?.stage?.pendingType).toBe('book_inventory_count')
    expect(inventoryCountsSave.mcp?.stage?.pendingType).toBe('save_inventory_count')
  })
})
