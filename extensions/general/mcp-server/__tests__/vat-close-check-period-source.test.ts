/**
 * gnubok_vat_close_check: period resolution and the ignored-transaction filter.
 *
 * Feedback seq 330091 (company with räkenskapsår 1 April..31 March, yearly
 * VAT): vat_close_check(yearly, 2026) answered with 2026-01-01..2026-12-31 and
 * a bare deadline_unavailable blocker, and a bank transaction the user had
 * ignored on purpose still counted as an uncategorized blocker.
 *
 * Helårsmoms is filed per räkenskapsår (SFL 26 kap 10-11 §§). resolvePeriodDates
 * already looks the räkenskapsår up, but its calendar fallback was silent.
 * The check now discloses the branch as `period.source` and, when the fallback
 * fires for a company whose fiscal year does not start in January, says so in
 * a blocker of its own instead of leaving the agent to infer it.
 *
 * Only the bank reconciliation is mocked (same reason as the completeness
 * suite): an unreconciled bank would add an unrelated blocker.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck } from '../server'

interface RecordedCall {
  table: string
  method: string
  args: unknown[]
}

/**
 * Table-routed Supabase double that also records every builder call, so the
 * filters the close check applies (not only what it returns) can be asserted.
 * Everything not listed answers empty, so no unrelated blocker fires.
 */
function mockSupabase(opts: {
  fiscalPeriods?: Array<{ period_start: string; period_end: string }>
  settings?: Record<string, unknown> | null
}) {
  const calls: RecordedCall[] = []
  const makeChain = (table: string, rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      }
    }
    return chain
  }

  const settings = opts.settings === undefined
    ? { moms_period: 'monthly', vat_taxable_base_over_40m: false }
    : opts.settings

  const supabase = {
    from: (table: string) => {
      if (table === 'fiscal_periods') return makeChain(table, opts.fiscalPeriods ?? [])
      if (table === 'company_settings') return makeChain(table, settings ? [settings] : [])
      return makeChain(table, [])
    },
    rpc: (fn: string) =>
      fn === 'verifikat_without_documents'
        ? Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
        : makeChain(fn, []),
  } as never

  const findCalls = (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args)

  return { supabase, findCalls }
}

const BROKEN_FY_SETTINGS = {
  moms_period: 'yearly',
  vat_taxable_base_over_40m: false,
  entity_type: 'aktiebolag',
  fiscal_year_start_month: 4,
  vat_has_eu_trade: false,
  vat_filing_method: 'electronic',
}

describe('gnubok_vat_close_check: ignored transactions', () => {
  it('excludes transactions ignored on purpose from the uncategorized blocker', async () => {
    // Ignored rows have journal_entry_id NULL by CHECK constraint, so the
    // "no journal entry" predicate alone counted them as work to do.
    const { supabase, findCalls } = mockSupabase({})

    const result = await computeVatCloseCheck(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(findCalls('transactions', 'is')).toEqual([['journal_entry_id', null]])
    expect(findCalls('transactions', 'eq')).toContainEqual(['is_ignored', false])
    expect(result.blockers).not.toContainEqual(expect.objectContaining({
      kind: 'uncategorized_transactions',
    }))
  })
})

describe('gnubok_vat_close_check: yearly period follows the räkenskapsår', () => {
  it('resolves the fiscal year ending in `year` for a broken FY (Apr-Mar)', async () => {
    const { supabase } = mockSupabase({
      fiscalPeriods: [{ period_start: '2025-04-01', period_end: '2026-03-31' }],
      settings: BROKEN_FY_SETTINGS,
    })

    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(result.period).toEqual({
      type: 'yearly',
      year: 2026,
      period: 1,
      start: '2025-04-01',
      end: '2026-03-31',
      source: 'fiscal_period',
    })
    // The configured fiscal year matches the resolved range, so the annual
    // deadline is computable and nothing about the period is a blocker.
    expect(result.payment.deadline).not.toBeNull()
    expect(result.blockers).not.toContainEqual(expect.objectContaining({ kind: 'fiscal_year_not_found' }))
    expect(result.blockers).not.toContainEqual(expect.objectContaining({ kind: 'deadline_unavailable' }))
  })

  it('discloses the calendar fallback and blocks when no fiscal year ends in `year` for a non-January FY', async () => {
    const { supabase } = mockSupabase({
      fiscalPeriods: [],
      settings: BROKEN_FY_SETTINGS,
    })

    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(result.period).toMatchObject({
      start: '2026-01-01',
      end: '2026-12-31',
      source: 'calendar_fallback',
    })
    expect(result.blockers).toContainEqual(expect.objectContaining({
      kind: 'fiscal_year_not_found',
      severity: 'high',
      message: expect.stringContaining('2026-01-01..2026-12-31'),
      hint: expect.stringContaining('gnubok_list_fiscal_periods'),
    }))
    expect(result.ready_to_close).toBe(false)
  })

  it('a calendar-FY company with no fiscal_periods row gets the fallback disclosed, not blocked', async () => {
    const { supabase } = mockSupabase({
      fiscalPeriods: [],
      settings: { ...BROKEN_FY_SETTINGS, fiscal_year_start_month: 1 },
    })

    const result = await computeVatCloseCheck(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      supabase,
    )

    expect(result.period.source).toBe('calendar_fallback')
    expect(result.period).toMatchObject({ start: '2026-01-01', end: '2026-12-31' })
    expect(result.blockers).not.toContainEqual(expect.objectContaining({ kind: 'fiscal_year_not_found' }))
  })

  it('monthly is a calendar period by law: source is calendar and fiscal_periods is never read', async () => {
    const { supabase, findCalls } = mockSupabase({})

    const result = await computeVatCloseCheck(
      { period_type: 'monthly', year: 2026, period: 3 },
      'company-1',
      supabase,
    )

    expect(result.period).toMatchObject({ start: '2026-03-01', end: '2026-03-31', source: 'calendar' })
    expect(findCalls('fiscal_periods', 'select')).toEqual([])
  })
})
