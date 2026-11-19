/**
 * Prior-import detection for a SIE file's fiscal year (issue #1667).
 *
 * findOverlappingPeriodImports returns ALL overlapping completed rows
 * newest-first and fails closed on query errors: `.limit(1).maybeSingle()`
 * with no ordering used to pick an arbitrary row when several overlapped.
 * checkDuplicatePeriodImport is its newest-row view.
 */
import { describe, it, expect } from 'vitest'
import { checkDuplicatePeriodImport, findOverlappingPeriodImports } from '../sie-import'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

function makePriorImportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'imp-prior',
    user_id: 'user-1',
    filename: 'old.se',
    file_hash: 'hash-old',
    fiscal_year_start: '2025-01-01',
    fiscal_year_end: '2025-12-31',
    transactions_count: 10,
    status: 'completed',
    fiscal_period_id: 'fp-2025',
    opening_balance_entry_id: null,
    imported_at: '2026-06-01T00:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

describe('findOverlappingPeriodImports', () => {
  it('returns every overlapping completed row, and [] when there are none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = [makePriorImportRow({ id: 'a' }), makePriorImportRow({ id: 'b' })]
    enqueue({ data: rows })

    const result = await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])

    const empty = await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(empty).toEqual([])
  })

  it('orders newest first so the pick is deterministic', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )

    const orderCalls = findCalls('sie_imports', 'order')
    expect(orderCalls).toEqual([
      ['imported_at', { ascending: false, nullsFirst: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ])
  })

  it('throws on a query error instead of returning [] (fail closed)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(
      findOverlappingPeriodImports(
        supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
      )
    ).rejects.toThrow(/connection reset/)
  })
})

describe('checkDuplicatePeriodImport', () => {
  it('returns the newest row when several overlap the period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        makePriorImportRow({ id: 'newest', imported_at: '2026-08-01T00:00:00Z' }),
        makePriorImportRow({ id: 'older', imported_at: '2026-05-01T00:00:00Z' }),
      ],
    })

    const result = await checkDuplicatePeriodImport(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result?.id).toBe('newest')
  })

  it('returns null when nothing overlaps', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = await checkDuplicatePeriodImport(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result).toBeNull()
  })
})
