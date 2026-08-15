import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildUnderlagPlan, planAcceptsTarget } from '@/lib/documents/underlag-import'
import type { FiscalPeriodRow, VoucherRow } from '@/lib/documents/voucher-ref-resolver'

const PERIOD_OPEN = 'period-open'
const PERIOD_LOCKED = 'period-locked'

const PERIODS: FiscalPeriodRow[] = [
  {
    id: PERIOD_OPEN,
    period_start: '2024-01-01',
    period_end: '2024-12-31',
    is_closed: false,
    locked_at: null,
  },
  {
    id: PERIOD_LOCKED,
    period_start: '2023-01-01',
    period_end: '2023-12-31',
    is_closed: true,
    locked_at: null,
  },
]

function makeVoucher(overrides: Partial<VoucherRow> & Pick<VoucherRow, 'id'>): VoucherRow {
  return {
    fiscal_period_id: PERIOD_OPEN,
    entry_date: '2024-03-14',
    description: 'Inköp kontorsmaterial',
    voucher_series: 'A',
    voucher_number: 47,
    source_voucher_series: 'A',
    source_voucher_number: 31,
    ...overrides,
  }
}

/**
 * Minimal Supabase double keyed on the query SHAPE rather than call order:
 * buildUnderlagPlan fires the voucher and period reads concurrently, so an
 * order-sensitive queue would make these tests flaky for no benefit.
 */
function makeSupabase(opts: {
  vouchers: VoucherRow[]
  periods?: FiscalPeriodRow[]
  /** Total migrated entries in the company, regardless of the number filter. */
  sourceRefCount?: number
}): SupabaseClient {
  const periods = opts.periods ?? PERIODS

  const from = (table: string) => {
    let filteredByNumber = false

    const result = () => {
      if (table === 'fiscal_periods') return { data: periods, error: null, count: periods.length }
      // Only the number-filtered read returns the voucher rows; the bare
      // count read answers "does this ledger have ANY source refs at all".
      return {
        data: filteredByNumber ? opts.vouchers : [],
        error: null,
        count: opts.sourceRefCount ?? opts.vouchers.length,
      }
    }

    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'not', 'order', 'limit', 'maybeSingle', 'single']) {
      chain[method] = () => chain
    }
    chain.in = () => {
      filteredByNumber = true
      return chain
    }
    chain.range = () => Promise.resolve(result())
    chain.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled)
    return chain
  }

  return { from } as unknown as SupabaseClient
}

describe('buildUnderlagPlan', () => {
  it('matches a filename prefix to the migrated verifikat it names', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    const plan = await buildUnderlagPlan(supabase, 'company-1', [
      'A31_8c2db060-79ba-4b6e-9f3d-4b0042aa5c52.pdf',
    ])

    expect(plan.rows[0]).toMatchObject({
      file_name: 'A31_8c2db060-79ba-4b6e-9f3d-4b0042aa5c52.pdf',
      status: 'matched',
      parsed_ref: { series: 'A', number: 31 },
      journal_entry_id: 'je-1',
    })
    expect(plan.rows[0].candidates[0]).toMatchObject({
      voucher_label: 'A47',
      source_voucher_label: 'A31',
      period_locked: false,
    })
    expect(plan.summary).toMatchObject({ total: 1, matched: 1 })
  })

  it('matches on the SOURCE number, not our renumbered one', async () => {
    // The import renumbered source A31 to A47. A file named after our own
    // number must NOT match: A47 does not exist in the source system.
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A47_kvitto.pdf'])

    expect(plan.rows[0].status).toBe('no_match')
  })

  it('reports a locked period instead of proposing a link the DB will refuse', async () => {
    const supabase = makeSupabase({
      vouchers: [makeVoucher({ id: 'je-1', fiscal_period_id: PERIOD_LOCKED })],
    })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf'])

    expect(plan.rows[0]).toMatchObject({ status: 'period_locked', journal_entry_id: 'je-1' })
    expect(plan.rows[0].candidates[0].period_locked).toBe(true)
    expect(plan.summary.period_locked).toBe(1)
  })

  it('treats a period with locked_at set as locked even when not closed', async () => {
    const supabase = makeSupabase({
      vouchers: [makeVoucher({ id: 'je-1' })],
      periods: [{ ...PERIODS[0], locked_at: '2025-01-31T00:00:00Z' }],
    })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf'])

    expect(plan.rows[0].status).toBe('period_locked')
  })

  it('surfaces every candidate when one ref spans several migrated years', async () => {
    const supabase = makeSupabase({
      vouchers: [
        makeVoucher({ id: 'je-2023', fiscal_period_id: PERIOD_LOCKED, entry_date: '2023-03-14' }),
        makeVoucher({ id: 'je-2024' }),
      ],
    })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf'])

    expect(plan.rows[0].status).toBe('ambiguous')
    expect(plan.rows[0].journal_entry_id).toBeNull()
    expect(plan.rows[0].candidates.map((c) => c.journal_entry_id)).toEqual(['je-2023', 'je-2024'])
    expect(plan.summary.ambiguous).toBe(1)
  })

  it('never auto-selects a series-less filename, even on a single hit', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['31.pdf'])

    expect(plan.rows[0]).toMatchObject({
      status: 'needs_confirmation',
      parsed_ref: { series: null, number: 31 },
      journal_entry_id: 'je-1',
    })
    expect(plan.summary.needs_confirmation).toBe(1)
  })

  it('reports an unreadable filename as unparsed without touching the ledger', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['kvitto ica.pdf'])

    expect(plan.rows[0]).toMatchObject({
      status: 'unparsed',
      parsed_ref: null,
      journal_entry_id: null,
      candidates: [],
    })
    expect(plan.summary.unparsed).toBe(1)
  })

  it('flags a ledger with no source refs at all, so the miss is explained', async () => {
    const supabase = makeSupabase({ vouchers: [], sourceRefCount: 0 })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf'])

    expect(plan.rows[0].status).toBe('no_match')
    expect(plan.no_source_refs).toBe(true)
  })

  it('does not blame missing source refs when the ledger has them', async () => {
    const supabase = makeSupabase({ vouchers: [], sourceRefCount: 120 })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf'])

    expect(plan.rows[0].status).toBe('no_match')
    expect(plan.no_source_refs).toBe(false)
  })

  it('skips the diagnostic round-trip once anything matched', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })], sourceRefCount: 0 })

    const plan = await buildUnderlagPlan(supabase, 'company-1', ['A31.pdf', 'kvitto.pdf'])

    expect(plan.no_source_refs).toBe(false)
  })

  it('counts a mixed batch correctly', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    const plan = await buildUnderlagPlan(supabase, 'company-1', [
      'A31_a.pdf',
      'A31_b.pdf',
      'A99.pdf',
      'kvitto.pdf',
    ])

    expect(plan.summary).toEqual({
      total: 4,
      matched: 2,
      needs_confirmation: 0,
      ambiguous: 0,
      period_locked: 0,
      no_match: 1,
      unparsed: 1,
    })
  })
})

describe('planAcceptsTarget', () => {
  it('accepts the entry the filename resolves to', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    await expect(planAcceptsTarget(supabase, 'company-1', 'A31.pdf', 'je-1')).resolves.toBe(true)
  })

  it('accepts any candidate of an ambiguous filename: the user picked one', async () => {
    const supabase = makeSupabase({
      vouchers: [
        makeVoucher({ id: 'je-2023', fiscal_period_id: PERIOD_LOCKED, entry_date: '2023-03-14' }),
        makeVoucher({ id: 'je-2024' }),
      ],
    })

    await expect(planAcceptsTarget(supabase, 'company-1', 'A31.pdf', 'je-2023')).resolves.toBe(true)
  })

  it('refuses an entry the filename does not point at', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    await expect(planAcceptsTarget(supabase, 'company-1', 'A31.pdf', 'je-other')).resolves.toBe(
      false,
    )
  })

  it('refuses an unreadable filename outright', async () => {
    const supabase = makeSupabase({ vouchers: [makeVoucher({ id: 'je-1' })] })

    await expect(planAcceptsTarget(supabase, 'company-1', 'kvitto.pdf', 'je-1')).resolves.toBe(
      false,
    )
  })
})
