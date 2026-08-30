import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMigrationCoverageEnd } from '@/lib/transactions/migration-coverage'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Recording chain mock: remembers every chained call so the test can assert
 * the exact filters. The generic createMockSupabase proxy swallows arguments.
 */
function createRecordingSupabase(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
  for (const method of ['select', 'eq', 'neq', 'order', 'limit']) {
    chain[method] = record(method)
  }
  chain.maybeSingle = vi.fn().mockImplementation((...args: unknown[]) => {
    calls.push({ method: 'maybeSingle', args })
    return Promise.resolve(result)
  })
  const from = vi.fn().mockImplementation((...args: unknown[]) => {
    calls.push({ method: 'from', args })
    return chain
  })
  return { supabase: { from } as unknown as SupabaseClient, calls }
}

describe('fetchMigrationCoverageEnd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the latest imported entry date', async () => {
    const { supabase } = createRecordingSupabase({
      data: { entry_date: '2026-06-30' },
      error: null,
    })
    await expect(fetchMigrationCoverageEnd(supabase, 'company-1')).resolves.toBe('2026-06-30')
  })

  it('returns null when the company has no imported entries', async () => {
    const { supabase } = createRecordingSupabase({ data: null, error: null })
    await expect(fetchMigrationCoverageEnd(supabase, 'company-1')).resolves.toBeNull()
  })

  it('queries posted import entries only, excluding the M-series adjustment', async () => {
    const { supabase, calls } = createRecordingSupabase({ data: null, error: null })
    await fetchMigrationCoverageEnd(supabase, 'company-1')

    expect(calls).toContainEqual({ method: 'from', args: ['journal_entries'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'posted'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['source_type', 'import'] })
    // The importer's omföringsverifikation is dated at fiscal year end; without
    // this exclusion a mid-year migration with skipped vouchers would get a
    // future cutoff again (the bug this module exists to fix).
    expect(calls).toContainEqual({ method: 'neq', args: ['voucher_series', 'M'] })
    expect(calls).toContainEqual({
      method: 'order',
      args: ['entry_date', { ascending: false }],
    })
    expect(calls).toContainEqual({ method: 'limit', args: [1] })
  })

  it('does not read sie_imports.fiscal_year_end', async () => {
    // Regression guard for the original bug: the cutoff must come from actual
    // imported data, never the #RAR-declared fiscal year.
    const { supabase, calls } = createRecordingSupabase({ data: null, error: null })
    await fetchMigrationCoverageEnd(supabase, 'company-1')
    expect(calls.filter((c) => c.method === 'from').map((c) => c.args[0])).toEqual([
      'journal_entries',
    ])
  })
})
