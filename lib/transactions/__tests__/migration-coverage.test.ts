import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchMigrationCoverageEnd } from '@/lib/transactions/migration-coverage'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Recording chain mock: remembers every chained call so the test can assert
 * the exact filters. The generic createMockSupabase proxy swallows arguments.
 * Results are dequeued per from() call: first for sie_imports (arm gate),
 * second for journal_entries.
 */
function createRecordingSupabase(results: Array<{ data: unknown; error: unknown }>) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const queue = [...results]
  const buildChain = () => {
    const result = queue.shift() ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args })
        return chain
      }
    for (const method of ['select', 'eq', 'neq', 'not', 'order', 'limit']) {
      chain[method] = record(method)
    }
    chain.maybeSingle = vi.fn().mockImplementation(() => {
      calls.push({ method: 'maybeSingle', args: [] })
      return Promise.resolve(result)
    })
    return chain
  }
  const from = vi.fn().mockImplementation((...args: unknown[]) => {
    calls.push({ method: 'from', args })
    return buildChain()
  })
  return { supabase: { from } as unknown as SupabaseClient, calls }
}

const armed = { data: { id: 'import-1' }, error: null }

describe('fetchMigrationCoverageEnd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the latest imported entry date for a migrated company', async () => {
    const { supabase } = createRecordingSupabase([
      armed,
      { data: { entry_date: '2026-06-30' }, error: null },
    ])
    await expect(fetchMigrationCoverageEnd(supabase, 'company-1')).resolves.toBe('2026-06-30')
  })

  it('returns null without a completed SIE import, even if import-typed entries exist', async () => {
    // Arm gate: source_type='import' is accepted from API clients, so a
    // company that never migrated must never get a cutoff from such entries.
    const { supabase, calls } = createRecordingSupabase([
      { data: null, error: null },
      { data: { entry_date: '2026-12-31' }, error: null },
    ])
    await expect(fetchMigrationCoverageEnd(supabase, 'company-1')).resolves.toBeNull()
    expect(calls.filter((c) => c.method === 'from').map((c) => c.args[0])).toEqual(['sie_imports'])
  })

  it('returns null when a migrated company has no imported entries', async () => {
    const { supabase } = createRecordingSupabase([armed, { data: null, error: null }])
    await expect(fetchMigrationCoverageEnd(supabase, 'company-1')).resolves.toBeNull()
  })

  it('arms on completed imports and takes the max over posted import entries excluding the omföringsverifikation', async () => {
    const { supabase, calls } = createRecordingSupabase([armed, { data: null, error: null }])
    await fetchMigrationCoverageEnd(supabase, 'company-1')

    expect(calls.filter((c) => c.method === 'from').map((c) => c.args[0])).toEqual([
      'sie_imports',
      'journal_entries',
    ])
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'completed'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'posted'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['source_type', 'import'] })
    // The importer's omföringsverifikation is dated at fiscal year end; without
    // this exclusion a mid-year migration with skipped vouchers would get a
    // future cutoff again (the bug this module exists to fix). Excluded by its
    // hardcoded description prefix, NOT by voucher series: imported vouchers
    // keep the source file's series, and real files use series M.
    expect(calls).toContainEqual({
      method: 'not',
      args: ['description', 'like', 'Omföringsverifikation:%'],
    })
    expect(calls.filter((c) => c.method === 'neq')).toEqual([])
    expect(calls).toContainEqual({
      method: 'order',
      args: ['entry_date', { ascending: false }],
    })
    expect(calls).toContainEqual({ method: 'limit', args: [1] })
  })

  it('never reads sie_imports.fiscal_year_end as the cutoff', async () => {
    // Regression guard for the original bug: the cutoff value must come from
    // actual imported data, never the #RAR-declared fiscal year. sie_imports
    // is consulted only as the arm gate (select id).
    const { supabase, calls } = createRecordingSupabase([armed, { data: null, error: null }])
    await fetchMigrationCoverageEnd(supabase, 'company-1')
    const selects = calls.filter((c) => c.method === 'select').map((c) => c.args[0])
    expect(selects).toEqual(['id', 'entry_date'])
  })
})
