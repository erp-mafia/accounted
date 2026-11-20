/**
 * gnubok_vat_close_check's `sanity` block, end to end through
 * computeVatCloseCheck: both periods are read through the declaration RPC and
 * compared per rate (compareVatPeriods, #129), and a previous period that
 * cannot be read is logged instead of swallowed.
 *
 * Only the bank reconciliation is mocked (as in the filed-net suite): an
 * unreconciled bank would add an unrelated blocker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

const logRecords = vi.hoisted(() => [] as { level: string; msg: string; [key: string]: unknown }[])
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base = {}) => actual.createTestLogger(module, logRecords as never, base),
  }
})

import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'

type Totals = { account_number: string; debit: number; credit: number }[]

// Q3 2026: all 500 000 kr of sales at 25 %. Q2 2026: 100 000 kr at 25 % and
// 400 000 kr of lodging at 12 %. Same ruta 05, so only the rate moved.
const Q3_LODGING_AT_25: Totals = [
  { account_number: '3001', debit: 0, credit: 500_000 },
  { account_number: '2611', debit: 0, credit: 125_000 },
]
const Q2_LODGING_AT_12: Totals = [
  { account_number: '3001', debit: 0, credit: 100_000 },
  { account_number: '3002', debit: 0, credit: 400_000 },
  { account_number: '2611', debit: 0, credit: 25_000 },
  { account_number: '2621', debit: 0, credit: 48_000 },
]

function mockSupabase(byStart: Record<string, Totals | 'error'>) {
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
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
      chain[m] = () => chain
    }
    return chain
  }
  return {
    from: (table: string) =>
      table === 'company_settings'
        ? makeChain([{ moms_period: 'quarterly', vat_taxable_base_over_40m: false }])
        : makeChain([]),
    rpc: (fn: string, params: { p_start?: string }) => {
      if (fn === 'get_vat_declaration_totals') {
        const totals = byStart[params.p_start ?? ''] ?? []
        if (totals === 'error') {
          return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } })
        }
        return Promise.resolve({
          data: { totals, settlement_shaped_entries: [], source_type_counts: {} },
          error: null,
        })
      }
      if (fn === 'verifikat_without_documents') {
        return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
      }
      return makeChain([])
    },
  } as never
}

const Q3 = { period_type: 'quarterly', year: 2026, period: 3 }

describe('gnubok_vat_close_check: sanity compares rate shares with the previous period', () => {
  beforeEach(() => {
    logRecords.length = 0
  })

  it('flags lodging moved from 12 % to 25 % as a rate share shift, advisory only', async () => {
    const result = await computeVatCloseCheck(
      Q3,
      'company-1',
      mockSupabase({ '2026-07-01': Q3_LODGING_AT_25, '2026-04-01': Q2_LODGING_AT_12 }),
    )

    expect(result.sanity.ratios.previous_period_compared).toBe(true)
    expect(result.sanity.ratios.rate_shares).toEqual({
      current: { '25': 100, '12': 0, '6': 0 },
      previous: { '25': 20, '12': 80, '6': 0 },
    })
    expect(result.sanity.anomalies.map((a) => [a.kind, a.rate, a.delta_pct])).toEqual([
      ['rate_share_shift', '25', 80],
      ['rate_share_shift', '12', -80],
    ])
    // The anomalies never add a blocker.
    expect(result.blockers.some((b) => (b.kind as string) === 'rate_share_shift')).toBe(false)
  })

  it('logs a previous period it cannot read and says the comparison did not run', async () => {
    const result = await computeVatCloseCheck(
      Q3,
      'company-1',
      mockSupabase({ '2026-07-01': Q3_LODGING_AT_25, '2026-04-01': 'error' }),
    )

    expect(result.sanity.anomalies).toEqual([])
    expect(result.sanity.ratios.previous_period_compared).toBe(false)
    expect(result.sanity.ratios.rate_shares.previous).toBeNull()
    expect(result.rutor.ruta10).toBe(125_000)

    const warning = logRecords.find((r) => r.msg === 'previous VAT period unavailable, sanity comparison skipped')
    expect(warning).toMatchObject({ level: 'warn' })
    expect(JSON.stringify(warning)).toContain('statement timeout')
  })
})
