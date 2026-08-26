/**
 * Regression: a periodisering must ALWAYS dissolve, even when the project (or
 * cost centre) the schedule is tagged with has been archived or dropped from
 * the registry since the origin invoice was booked.
 *
 * Dissolution lines carry the origin's dimensions bag, which pulls them into
 * validateEntryDimensions. With dimensions_enabled and an archived value that
 * validator rejects the entry, postDueInstallments catches the rejection,
 * writes last_error and leaves the installment pending: the remaining months
 * of cost never reach the P&L account, the interim 17xx/29xx account stays
 * overstated, and the trial balance still balances so nothing downstream
 * notices. Hence the source-type exemption in createDraftEntry.
 *
 * Unlike service.test.ts this file does NOT mock the engine: the whole chain
 * (schedule bag -> dissolution lines -> createDraftEntry -> commit) runs, so
 * the test fails if the exemption is removed anywhere along it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { postDueInstallments } from '@/lib/bookkeeping/accruals/service'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: vi.fn().mockResolvedValue([]),
}))

const COMPANY = 'company-1'
const USER = 'user-1'

interface Result {
  data?: unknown
  error?: unknown
  count?: number
}

interface TableMock {
  /** Results for awaited (thenable) chains, consumed in order; last repeats. */
  rows?: Result[]
  /** Result for .single() / .maybeSingle() on this table. */
  row?: Result
}

/**
 * Table-keyed Supabase mock. Awaited chains and .single() resolve from
 * separate slots because several tables are read both ways (fiscal_periods:
 * findFiscalPeriod takes the list, createDraftEntry takes the row).
 */
function buildSupabase(tables: Record<string, TableMock>) {
  const inserts: Record<string, unknown[]> = {}
  const updates: Record<string, unknown[]> = {}
  const cursor: Record<string, number> = {}

  const nextRows = (table: string): Result => {
    const list = tables[table]?.rows ?? []
    if (list.length === 0) return { data: null, error: null }
    const index = Math.min(cursor[table] ?? 0, list.length - 1)
    cursor[table] = index + 1
    return { data: null, error: null, ...list[index] }
  }

  const from = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'in', 'gt', 'gte', 'lte', 'order', 'limit', 'delete']) {
      chain[method] = vi.fn().mockReturnValue(chain)
    }
    chain.insert = vi.fn().mockImplementation((payload: unknown) => {
      ;(inserts[table] ??= []).push(payload)
      return chain
    })
    chain.update = vi.fn().mockImplementation((payload: unknown) => {
      ;(updates[table] ??= []).push(payload)
      return chain
    })
    const single = vi.fn().mockImplementation(async () => ({
      data: null,
      error: null,
      ...(tables[table]?.row ?? {}),
    }))
    chain.single = single
    chain.maybeSingle = single
    chain.then = (resolve: (value: unknown) => void) => resolve(nextRows(table))
    return chain
  })

  const supabase = {
    from,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }

  return { supabase, inserts, updates, queriedTables: () => from.mock.calls.map((c) => c[0] as string) }
}

/** Expense schedule tagged with project P001 on dimension 6. */
function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    user_id: USER,
    company_id: COMPANY,
    direction: 'expense',
    supplier_invoice_id: 'si-1',
    supplier_invoice_item_id: 'sii-1',
    invoice_id: null,
    invoice_item_id: null,
    balance_account: '1730',
    target_account: '6310',
    total_amount: 12000,
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    months: 12,
    origin_journal_entry_id: 'je-origin',
    posting_floor_date: '2026-01-15',
    status: 'active',
    description: 'Försäkring 2026',
    dimensions: { '6': 'P001' },
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function makeInstallment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inst-1',
    user_id: USER,
    company_id: COMPANY,
    schedule_id: 'sched-1',
    period_month: '2026-07-01',
    amount: 1000,
    status: 'pending',
    journal_entry_id: null,
    posted_at: null,
    last_error: null,
    schedule: makeSchedule(),
    ...overrides,
  }
}

/**
 * @param valueRows rows the registry returns for P001. Empty = the value was
 *   removed; is_active false = it was archived.
 */
function buildTables(valueRows: Array<Record<string, unknown>>): Record<string, TableMock> {
  return {
    accrual_schedule_installments: {
      rows: [
        { data: [makeInstallment()] }, // due installments
        { data: [{ id: 'inst-1' }] }, // CAS claim
        { count: 0 }, // remaining pending
      ],
    },
    company_settings: {
      row: {
        data: {
          bookkeeping_locked_through: null,
          dimensions_enabled: true,
          default_voucher_series_per_source_type: null,
        },
      },
    },
    fiscal_periods: {
      rows: [{ data: [{ id: 'fp-1' }] }],
      row: { data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' } },
    },
    account_dimension_rules: { rows: [{ data: [] }] },
    dimensions: { rows: [{ data: [{ id: 'dim-proj', sie_dim_no: 6 }] }] },
    dimension_values: { rows: [{ data: valueRows }] },
    chart_of_accounts: {
      rows: [
        {
          data: [
            { id: 'acc-6310', account_number: '6310' },
            { id: 'acc-1730', account_number: '1730' },
          ],
        },
      ],
    },
    journal_entries: { row: { data: { id: 'je-1', status: 'draft', voucher_series: 'A' } } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('postDueInstallments with an archived dimension value', () => {
  it('posts the dissolution and keeps the tag', async () => {
    const { supabase, inserts, updates } = buildSupabase(
      buildTables([{ dimension_id: 'dim-proj', code: 'P001', is_active: false }])
    )

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-07-20',
    })

    expect(result).toMatchObject({ posted: 1, failed: 0, skipped: 0, errors: [] })

    // Both lines booked, both still tagged with the archived project: the cost
    // belongs to P001 whether or not the value is still selectable.
    const lineRows = inserts.journal_entry_lines[0] as Array<Record<string, unknown>>
    expect(lineRows).toHaveLength(2)
    expect(lineRows[0]).toMatchObject({
      account_number: '6310',
      debit_amount: 1000,
      dimensions: { '6': 'P001' },
    })
    expect(lineRows[1]).toMatchObject({
      account_number: '1730',
      credit_amount: 1000,
      dimensions: { '6': 'P001' },
    })

    // The installment was claimed, not parked with a last_error for the cron
    // to retry forever.
    const installmentUpdates = (updates.accrual_schedule_installments ?? []) as Array<
      Record<string, unknown>
    >
    expect(installmentUpdates).toHaveLength(1)
    expect(installmentUpdates[0]).toMatchObject({ status: 'posted', journal_entry_id: 'je-1' })
    expect(installmentUpdates.some((u) => typeof u.last_error === 'string')).toBe(false)
  })

  it('posts the dissolution when the tagged value is gone from the registry', async () => {
    const { supabase, inserts } = buildSupabase(buildTables([]))

    const result = await postDueInstallments(supabase as unknown as SupabaseClient, COMPANY, {
      userId: USER,
      today: '2026-07-20',
    })

    expect(result).toMatchObject({ posted: 1, failed: 0 })
    const lineRows = inserts.journal_entry_lines[0] as Array<Record<string, unknown>>
    expect(lineRows[0]).toMatchObject({ dimensions: { '6': 'P001' } })
  })
})
