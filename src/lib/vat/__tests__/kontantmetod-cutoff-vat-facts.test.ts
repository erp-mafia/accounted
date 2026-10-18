import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/core/bookkeeping/kontantmetod-cutoff', () => ({
  assessKontantmetodCutoff: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  findNextPeriod: vi.fn(),
}))

import { fetchKontantmetodCutoffVatFacts } from '../kontantmetod-cutoff-vat-facts'
import { assessKontantmetodCutoff } from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { findNextPeriod } from '@/lib/core/bookkeeping/period-service'

type Row = Record<string, unknown>

/** A stand-in that applies eq / in / gte / lte to seeded tables. */
function makeSupabase(tables: Record<string, Row[]>, failTable?: string) {
  const from = vi.fn((table: string) => {
    const keep: Array<(row: Row) => boolean> = []
    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = (c: string, v: unknown) => { keep.push((r) => r[c] === v); return q }
    q.in = (c: string, v: unknown[]) => { keep.push((r) => v.includes(r[c])); return q }
    q.gte = (c: string, v: string) => { keep.push((r) => String(r[c]) >= v); return q }
    q.lte = (c: string, v: string) => { keep.push((r) => String(r[c]) <= v); return q }
    const result = () => table === failTable
      ? { data: null, error: { message: 'boom' } }
      : { data: (tables[table] ?? []).filter((r) => keep.every((k) => k(r))), error: null }
    q.maybeSingle = async () => {
      const r = result()
      return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }
    }
    q.then = (resolve: (v: unknown) => unknown) => resolve(result())
    return q
  })
  return { from }
}

const cashSettings = { company_id: 'co-1', accounting_method: 'cash', entity_type: 'aktiebolag' }
const fy2026 = { id: 'fp-2026', company_id: 'co-1', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findNextPeriod).mockResolvedValue(null)
  vi.mocked(assessKontantmetodCutoff).mockResolvedValue({ complete: false } as never)
})

describe('fetchKontantmetodCutoffVatFacts', () => {
  it('returns nothing for a company that does not use kontantmetoden, and assesses nothing', async () => {
    const supabase = makeSupabase({ company_settings: [{ ...cashSettings, accounting_method: 'accrual' }], fiscal_periods: [fy2026] })
    await expect(fetchKontantmetodCutoffVatFacts(supabase as never, 'co-1', '2026-10-01', '2026-12-31')).resolves.toBeUndefined()
    expect(assessKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('lists an open fiscal year ending inside the period whose cut-off is incomplete', async () => {
    const supabase = makeSupabase({ company_settings: [cashSettings], fiscal_periods: [fy2026] })
    const facts = await fetchKontantmetodCutoffVatFacts(supabase as never, 'co-1', '2026-10-01', '2026-12-31')
    expect(facts).toEqual({
      incompleteYearEnds: [{ fiscal_period_id: 'fp-2026', period_end: '2026-12-31' }],
      legacyCutoffPeriodEnds: [],
    })
    expect(assessKontantmetodCutoff).toHaveBeenCalledWith(
      supabase, 'co-1', expect.objectContaining({ id: 'fp-2026' }), null, 'aktiebolag',
    )
  })

  it('is silent for a VAT period without a year end, a complete cut-off, or a closed year', async () => {
    const quiet = makeSupabase({ company_settings: [cashSettings], fiscal_periods: [fy2026] })
    await expect(fetchKontantmetodCutoffVatFacts(quiet as never, 'co-1', '2026-07-01', '2026-09-30'))
      .resolves.toEqual({ incompleteYearEnds: [], legacyCutoffPeriodEnds: [] })
    expect(assessKontantmetodCutoff).not.toHaveBeenCalled()

    vi.mocked(assessKontantmetodCutoff).mockResolvedValueOnce({ complete: true } as never)
    await expect(fetchKontantmetodCutoffVatFacts(quiet as never, 'co-1', '2026-10-01', '2026-12-31'))
      .resolves.toEqual({ incompleteYearEnds: [], legacyCutoffPeriodEnds: [] })

    const closed = makeSupabase({ company_settings: [cashSettings], fiscal_periods: [{ ...fy2026, is_closed: true }] })
    vi.mocked(assessKontantmetodCutoff).mockClear()
    await expect(fetchKontantmetodCutoffVatFacts(closed as never, 'co-1', '2026-10-01', '2026-12-31'))
      .resolves.toEqual({ incompleteYearEnds: [], legacyCutoffPeriodEnds: [] })
    expect(assessKontantmetodCutoff).not.toHaveBeenCalled()
  })

  it('names a legacy cut-off whose verifikat (aggregate or vändning) fall inside the period', async () => {
    vi.mocked(assessKontantmetodCutoff).mockResolvedValue({ complete: true } as never)
    const supabase = makeSupabase({
      company_settings: [cashSettings],
      fiscal_periods: [],
      kontantmetod_cutoff_entries: [
        { company_id: 'co-1', kind: 'receivable_reversal', entry: { entry_date: '2026-01-01', status: 'posted' } },
        { company_id: 'co-1', kind: 'payable', entry: { entry_date: '2025-12-31', status: 'posted' } },
        { company_id: 'co-1', kind: 'receivable_reversal', entry: { entry_date: '2026-02-01', status: 'reversed' } },
      ],
    })
    const q1 = await fetchKontantmetodCutoffVatFacts(supabase as never, 'co-1', '2026-01-01', '2026-03-31')
    expect(q1?.legacyCutoffPeriodEnds).toEqual(['2025-12-31'])
    const q2 = await fetchKontantmetodCutoffVatFacts(supabase as never, 'co-1', '2026-04-01', '2026-06-30')
    expect(q2?.legacyCutoffPeriodEnds).toEqual([])
  })

  it('never throws: a failed read comes back as unavailable', async () => {
    const supabase = makeSupabase({ company_settings: [cashSettings], fiscal_periods: [fy2026] }, 'fiscal_periods')
    await expect(fetchKontantmetodCutoffVatFacts(supabase as never, 'co-1', '2026-10-01', '2026-12-31'))
      .resolves.toEqual({ incompleteYearEnds: [], legacyCutoffPeriodEnds: [], unavailable: true })
    vi.mocked(assessKontantmetodCutoff).mockRejectedValueOnce(new Error('timeout'))
    const ok = makeSupabase({ company_settings: [cashSettings], fiscal_periods: [fy2026] })
    await expect(fetchKontantmetodCutoffVatFacts(ok as never, 'co-1', '2026-10-01', '2026-12-31'))
      .resolves.toMatchObject({ unavailable: true })
  })
})
