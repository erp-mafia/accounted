import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchMigrationCoverageEnd,
  fetchOpenPreMigrationRows,
  preMigrationScanAccount,
} from '@/lib/transactions/migration-coverage'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

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

describe('preMigrationScanAccount', () => {
  it('widens every bank account (1910-1949) and a missing ledger to the whole bank range', () => {
    // crm#1239: the cash account's ledger mapping is set up after the old
    // system booked, so the movement may sit on another bank account.
    expect(preMigrationScanAccount('1930')).toBeNull()
    expect(preMigrationScanAccount('1940')).toBeNull()
    expect(preMigrationScanAccount('1910')).toBeNull()
    expect(preMigrationScanAccount('1949')).toBeNull()
    expect(preMigrationScanAccount(null)).toBeNull()
    expect(preMigrationScanAccount(undefined)).toBeNull()
    expect(preMigrationScanAccount('  ')).toBeNull()
  })

  it('keeps any other settlement account exactly itself', () => {
    expect(preMigrationScanAccount('1686')).toBe('1686')
    expect(preMigrationScanAccount('2890')).toBe('2890')
    expect(preMigrationScanAccount('1950')).toBe('1950')
    expect(preMigrationScanAccount('19300')).toBe('19300')
  })
})

describe('fetchOpenPreMigrationRows', () => {
  const openRow = (id: string, date: string, amount: number | string, cashAccountId: string | null) => ({
    id,
    date,
    amount,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    cash_account_id: cashAccountId,
  })

  it('reads the open inbox rows on or before the coverage end, in a stable paging order', async () => {
    const { supabase, setTable, findCall, findCalls, tables } = createTableMockSupabase()
    setTable('transactions', { data: [openRow('tx-1', '2026-09-18', -27500, null)] })

    await fetchOpenPreMigrationRows(supabase as unknown as SupabaseClient, 'company-1', '2026-10-16')

    expect(findCall('transactions', 'select')).toEqual([
      'id, date, amount, currency, amount_sek, exchange_rate, cash_account_id',
    ])
    expect(findCalls('transactions', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['is_ignored', false],
    ])
    expect(findCalls('transactions', 'is')).toEqual([
      ['journal_entry_id', null],
      ['is_business', null],
    ])
    expect(findCall('transactions', 'lte')).toEqual(['date', '2026-10-16'])
    expect(findCalls('transactions', 'order')).toEqual([
      ['date', { ascending: true }],
      ['id', { ascending: true }],
    ])
    // No row names a cash account: no lookup.
    expect(tables()).toEqual(['transactions'])
  })

  it('groups the rows per cash account with the ledger scope each one is searched in', async () => {
    const { supabase, setTable, findCall } = createTableMockSupabase()
    setTable('transactions', {
      data: [
        openRow('tx-bank-1', '2026-09-18', '-27500', 'ca-bank'),
        openRow('tx-card', '2026-09-20', -199, 'ca-card'),
        openRow('tx-bank-2', '2026-09-30', -7874, 'ca-bank'),
        openRow('tx-loose', '2026-10-01', -292.95, null),
      ],
    })
    setTable('cash_accounts', {
      data: [
        { id: 'ca-bank', ledger_account: '1940' },
        { id: 'ca-card', ledger_account: '2890' },
      ],
    })

    const groups = await fetchOpenPreMigrationRows(supabase as unknown as SupabaseClient, 'company-1', '2026-10-16')

    expect(findCall('cash_accounts', 'eq')).toEqual(['company_id', 'company-1'])
    expect(groups.map((g) => ({ scan: g.scanAccount, ids: g.rows.map((r) => r.id) }))).toEqual([
      { scan: null, ids: ['tx-bank-1', 'tx-bank-2'] },
      { scan: '2890', ids: ['tx-card'] },
      { scan: null, ids: ['tx-loose'] },
    ])
    // PostgREST hands numerics over as strings; the detector sums numbers.
    expect(groups[0].rows[0]).toEqual({
      id: 'tx-bank-1',
      date: '2026-09-18',
      amount: -27500,
      currency: 'SEK',
      amount_sek: null,
      exchange_rate: null,
    })
  })

  it('returns no groups without open rows and reads no cash accounts', async () => {
    const { supabase, setTable, tables } = createTableMockSupabase()
    setTable('transactions', { data: [] })

    await expect(
      fetchOpenPreMigrationRows(supabase as unknown as SupabaseClient, 'company-1', '2026-10-16'),
    ).resolves.toEqual([])
    expect(tables()).toEqual(['transactions'])
  })

  it('throws when the cash account lookup fails: a row scope would be a guess', async () => {
    const { supabase, setTable } = createTableMockSupabase()
    setTable('transactions', { data: [openRow('tx-1', '2026-09-18', -27500, 'ca-1')] })
    setTable('cash_accounts', { error: { message: 'boom' } })

    await expect(
      fetchOpenPreMigrationRows(supabase as unknown as SupabaseClient, 'company-1', '2026-10-16'),
    ).rejects.toThrow('cash account lookup failed')
  })
})
