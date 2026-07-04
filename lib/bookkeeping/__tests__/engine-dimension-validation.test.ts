/**
 * Engine wiring of validateEntryDimensions (dimensions plan PR3).
 *
 * createDraftEntry and updateDraftEntry must run the soft dimension
 * validation AFTER balance validation and BEFORE any insert/update, so a
 * rejection leaves no orphan rows. Untagged entries must not even fetch
 * company_settings; companies without the toggle keep free-text passthrough.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createDraftEntry, updateDraftEntry } from '../engine'
import { DimensionValidationError } from '../errors'
import type { CreateJournalEntryInput } from '@/types'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

interface TableResult {
  data?: unknown
  error?: unknown
}

/**
 * Table-keyed Supabase mock: every from(table) call returns a chain resolving
 * to the configured result for that table. insert payloads are captured per
 * table so tests can assert what would have been written.
 */
function buildSupabase(tables: Record<string, TableResult>) {
  const inserts: Record<string, unknown[]> = {}
  const updates: Record<string, unknown[]> = {}

  const from = vi.fn().mockImplementation((table: string) => {
    const result = tables[table] ?? {}
    const resolved = { data: result.data ?? null, error: result.error ?? null }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'delete', 'order', 'limit', 'lte', 'gte']) {
      chain[m] = vi.fn().mockReturnValue(chain)
    }
    chain.insert = vi.fn().mockImplementation((payload: unknown) => {
      ;(inserts[table] ??= []).push(payload)
      return chain
    })
    chain.update = vi.fn().mockImplementation((payload: unknown) => {
      ;(updates[table] ??= []).push(payload)
      return chain
    })
    chain.single = vi.fn().mockResolvedValue(resolved)
    chain.maybeSingle = vi.fn().mockResolvedValue(resolved)
    chain.then = (resolve: (v: unknown) => void) => resolve(resolved)
    return chain
  })

  const supabase = {
    from,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }

  const queriedTables = () => from.mock.calls.map((call) => call[0] as string)

  return { supabase, inserts, updates, queriedTables }
}

const BASE_TABLES: Record<string, TableResult> = {
  fiscal_periods: {
    data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  },
  chart_of_accounts: {
    data: [
      { account_number: '1930', id: 'acc-1930' },
      { account_number: '4010', id: 'acc-4010' },
    ],
  },
  journal_entries: {
    data: { id: 'entry-1', status: 'draft', voucher_series: 'A', lines: [] },
  },
  journal_entry_lines: { data: null },
}

const DIMENSION_TABLES: Record<string, TableResult> = {
  company_settings: { data: { dimensions_enabled: true } },
  dimensions: {
    data: [
      { id: 'dim-ks', sie_dim_no: 1 },
      { id: 'dim-proj', sie_dim_no: 6 },
    ],
  },
  dimension_values: {
    data: [
      { dimension_id: 'dim-ks', code: 'KS01', is_active: true },
      { dimension_id: 'dim-proj', code: 'P001', is_active: true },
    ],
  },
}

function makeInput(dimensions?: Record<string, string>): CreateJournalEntryInput {
  return {
    fiscal_period_id: 'period-1',
    entry_date: '2026-06-15',
    description: 'Materialinköp',
    source_type: 'manual',
    // Explicit series keeps resolveSeriesFromSettings from also querying
    // company_settings, so the assertions below isolate the validation fetch.
    voucher_series: 'A',
    lines: [
      { account_number: '4010', debit_amount: 100, credit_amount: 0, dimensions },
      { account_number: '1930', debit_amount: 0, credit_amount: 100, dimensions },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createDraftEntry: dimension validation wiring', () => {
  it('never fetches company_settings for an untagged entry', async () => {
    const { supabase, queriedTables } = buildSupabase(BASE_TABLES)

    const entry = await createDraftEntry(supabase as never, 'company-1', 'user-1', makeInput())

    expect(entry.id).toBe('entry-1')
    expect(queriedTables()).not.toContain('company_settings')
    expect(queriedTables()).not.toContain('dimensions')
    expect(queriedTables()).not.toContain('dimension_values')
  })

  it('passes tagged lines through untouched when dimensions_enabled is false', async () => {
    const { supabase, inserts, queriedTables } = buildSupabase({
      ...BASE_TABLES,
      company_settings: { data: { dimensions_enabled: false } },
    })

    const entry = await createDraftEntry(
      supabase as never,
      'company-1',
      'user-1',
      makeInput({ '6': 'FRITEXT-PROJEKT' })
    )

    expect(entry.id).toBe('entry-1')
    // Toggle checked once, registry never consulted (free-text passthrough).
    expect(queriedTables().filter((t) => t === 'company_settings')).toHaveLength(1)
    expect(queriedTables()).not.toContain('dimensions')
    // The free-text tag still lands on the inserted lines (bag only: the
    // project mirror is GENERATED at the database since the PR9 cutover).
    const lineRows = inserts.journal_entry_lines[0] as Array<Record<string, unknown>>
    expect(lineRows[0].dimensions).toEqual({ '6': 'FRITEXT-PROJEKT' })
    expect('project' in lineRows[0]).toBe(false)
  })

  it('rejects an unknown code before ANY row is inserted (toggle on)', async () => {
    const { supabase, inserts, queriedTables } = buildSupabase({
      ...BASE_TABLES,
      ...DIMENSION_TABLES,
      dimension_values: { data: [] },
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', makeInput({ '6': 'P999' }))
    ).rejects.toBeInstanceOf(DimensionValidationError)

    expect(queriedTables()).not.toContain('journal_entries')
    expect(inserts.journal_entries).toBeUndefined()
    expect(inserts.journal_entry_lines).toBeUndefined()
  })

  it('rejects an archived value with the Swedish reactivation message', async () => {
    const { supabase } = buildSupabase({
      ...BASE_TABLES,
      ...DIMENSION_TABLES,
      dimension_values: {
        data: [{ dimension_id: 'dim-proj', code: 'P001', is_active: false }],
      },
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', makeInput({ '6': 'P001' }))
    ).rejects.toThrow('"P001" är arkiverat: återaktivera värdet för att använda det.')
  })

  it('creates the draft when every tagged code is registered and active', async () => {
    const { supabase, inserts } = buildSupabase({ ...BASE_TABLES, ...DIMENSION_TABLES })

    const entry = await createDraftEntry(
      supabase as never,
      'company-1',
      'user-1',
      makeInput({ '1': 'KS01', '6': 'P001' })
    )

    expect(entry.id).toBe('entry-1')
    const lineRows = inserts.journal_entry_lines[0] as Array<Record<string, unknown>>
    expect(lineRows[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    // PR9 cutover: the payload must NOT name the generated mirror columns:
    // an explicit value would make Postgres reject the insert.
    expect('cost_center' in lineRows[0]).toBe(false)
    expect('project' in lineRows[0]).toBe(false)
  })
})

describe('updateDraftEntry: dimension validation wiring', () => {
  it('rejects an unknown code before the header or lines are touched', async () => {
    const { supabase, updates, queriedTables } = buildSupabase({
      ...BASE_TABLES,
      ...DIMENSION_TABLES,
      dimension_values: { data: [] },
    })

    await expect(
      updateDraftEntry(supabase as never, 'company-1', 'user-1', 'entry-1', makeInput({ '6': 'P999' }))
    ).rejects.toBeInstanceOf(DimensionValidationError)

    // journal_entries is hit exactly once: the draft-status load. The header
    // update and the delete/insert of lines must never run.
    expect(queriedTables().filter((t) => t === 'journal_entries')).toHaveLength(1)
    expect(updates.journal_entries).toBeUndefined()
    expect(queriedTables()).not.toContain('journal_entry_lines')
  })

  it('updates an untagged draft without ever fetching company_settings', async () => {
    const { supabase, queriedTables } = buildSupabase(BASE_TABLES)

    const entry = await updateDraftEntry(
      supabase as never,
      'company-1',
      'user-1',
      'entry-1',
      makeInput()
    )

    expect(entry.id).toBe('entry-1')
    expect(queriedTables()).not.toContain('company_settings')
  })

  it('updates a draft with valid registered codes', async () => {
    const { supabase, inserts } = buildSupabase({ ...BASE_TABLES, ...DIMENSION_TABLES })

    const entry = await updateDraftEntry(
      supabase as never,
      'company-1',
      'user-1',
      'entry-1',
      makeInput({ '6': 'P001' })
    )

    expect(entry.id).toBe('entry-1')
    const lineRows = inserts.journal_entry_lines[0] as Array<Record<string, unknown>>
    expect(lineRows[0].dimensions).toEqual({ '6': 'P001' })
  })
})
