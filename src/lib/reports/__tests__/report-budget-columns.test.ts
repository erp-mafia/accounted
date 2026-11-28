/**
 * The budget in the reports (accounted#134, part 2): the resultatrapport's
 * Budget and Avvikelse figures (rows budgeted but not booked included), the
 * per-dimension report's budget per value column, and their whole-month
 * rule. loadReportBudget's own reads are tested in
 * lib/budgets/__tests__/report-budget.test.ts; here it is mocked, as the
 * trial balance is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrialBalanceRow } from '@/types'

vi.mock('../trial-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../trial-balance')>()),
  generateTrialBalance: vi.fn(),
}))
vi.mock('../latest-vouchers', () => ({ getLatestPostedVouchers: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/budgets/report-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/budgets/report-budget')>()),
  loadReportBudget: vi.fn(),
}))

import { generateResultatrapport } from '../resultatrapport'
import { generateDimensionPnl } from '../dimension-pnl'
import { dimensionPnlMeasure } from '../dimension-pnl-measure'
import { generateTrialBalance } from '../trial-balance'
import { loadReportBudget, type LoadedReportBudget } from '@/lib/budgets/report-budget'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockLoadBudget = vi.mocked(loadReportBudget)

type MockResult = { data?: unknown; error?: unknown }
let queued: Record<string, MockResult[]>

function builder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not', 'or', 'contains', 'order', 'range', 'limit']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = () => queued[table]?.shift() ?? { data: null, error: null }
  b.single = vi.fn().mockImplementation(async () => consume())
  b.maybeSingle = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function client() {
  return {
    from: vi.fn().mockImplementation((table: string) => builder(table)),
    rpc: vi.fn().mockImplementation(async (fn: string) => (fn === 'get_dimension_pnl_buckets' ? queued.buckets?.shift() ?? { data: [], error: null } : { data: null, error: null })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function tbRow(partial: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '3001',
    account_name: 'Försäljning',
    account_class: 3,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...partial,
  }
}

const tb = (rows: TrialBalanceRow[]) => ({ rows, totalDebit: 0, totalCredit: 0, isBalanced: true })
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31', previous_period_id: null }
const BUDGET_INFO = { budget_id: 'b1', name: 'Budget 2026', is_default: true, applied: true, from_month: '2026-01', to_month: '2026-12' }

function loaded(byAccount: Record<string, number>, extra: Partial<LoadedReportBudget> = {}): LoadedReportBudget {
  return {
    info: BUDGET_INFO,
    byAccount: new Map(Object.entries(byAccount)),
    byAccountCode: new Map(),
    accountNames: new Map([['5010', 'Lokalhyra']]),
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  queued = {}
})

describe('generateResultatrapport with a budget', () => {
  it('adds Budget and Avvikelse to every row, subtotal and the result, and a row for a budget with no actuals', async () => {
    queued = { fiscal_periods: [{ data: PERIOD, error: null }] }
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', period_credit: 120000 }),
        tbRow({ account_number: '4010', account_name: 'Inköp', account_class: 4, period_debit: 30000 }),
      ]),
    )
    // Budget in the report's sign: revenue 100 000, costs -40 000 and rent -12 000 never booked.
    mockLoadBudget.mockResolvedValue(loaded({ '3001': 100000, '4010': -40000, '5010': -12000 }))

    const report = await generateResultatrapport(client(), 'company-1', 'period-1', { budgetId: 'b1' })

    expect(report.budget).toEqual(BUDGET_INFO)
    const revenue = report.groups.find((g) => g.class === 3)!
    expect(revenue.rows[0]!.budget).toEqual({ budget: 100000, deviation: 20000, deviation_percent: 20 })
    const costs = report.groups.find((g) => g.class === 4)!
    // Less cost than budgeted is a positive deviation.
    expect(costs.rows[0]!.budget).toEqual({ budget: -40000, deviation: 10000, deviation_percent: 25 })
    const rent = report.groups.find((g) => g.class === 5)!
    expect(rent.rows).toEqual([
      {
        account_number: '5010',
        account_name: 'Lokalhyra',
        current_period: 0,
        prior_period: 0,
        budget: { budget: -12000, deviation: 12000, deviation_percent: 100 },
      },
    ])
    expect(rent.subtotal_budget).toEqual({ budget: -12000, deviation: 12000, deviation_percent: 100 })
    expect(report.net_result_current).toBe(90000)
    expect(report.net_result_budget).toEqual({ budget: 48000, deviation: 42000, deviation_percent: 87.5 })
  })

  it('gives each class-8 block and Resultat efter finansiella poster its budget', async () => {
    queued = { fiscal_periods: [{ data: PERIOD, error: null }] }
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', period_credit: 120000 }),
        tbRow({ account_number: '8410', account_name: 'Räntekostnader', account_class: 8, period_debit: 2000 }),
        tbRow({ account_number: '8910', account_name: 'Skatt', account_class: 8, period_debit: 20000 }),
      ]),
    )
    // Interest budgeted, a periodiseringsfond budgeted but never booked.
    mockLoadBudget.mockResolvedValue(
      loaded({ '3001': 100000, '8410': -1000, '8811': -10000 }, { accountNames: new Map([['8811', 'Avsättning till periodiseringsfond']]) }),
    )

    const report = await generateResultatrapport(client(), 'company-1', 'period-1', { budgetId: 'b1' })

    const subgroups = report.groups.find((g) => g.class === 8)!.subgroups!
    expect(subgroups.map((s) => [s.key, s.subtotal_current, s.subtotal_budget])).toEqual([
      ['finansiella_poster', -2000, { budget: -1000, deviation: -1000, deviation_percent: -100 }],
      ['bokslutsdispositioner', 0, { budget: -10000, deviation: 10000, deviation_percent: 100 }],
      ['skatter', -20000, { budget: 0, deviation: -20000, deviation_percent: null }],
    ])
    expect(report.result_after_financial).toEqual({
      label: 'Resultat efter finansiella poster',
      current: 118000,
      prior: 0,
      budget: { budget: 99000, deviation: 19000, deviation_percent: 19.19 },
    })
  })

  it('passes the window and the dimension filter to the budget, and shows no figures when it cuts a month', async () => {
    queued = { fiscal_periods: [{ data: PERIOD, error: null }] }
    mockTrialBalance.mockResolvedValue(tb([tbRow({ period_credit: 5000 })]))
    mockLoadBudget.mockResolvedValue(loaded({}, { info: { ...BUDGET_INFO, applied: false, from_month: null, to_month: null } }))

    const report = await generateResultatrapport(client(), 'company-1', 'period-1', {
      fromDate: '2026-01-01',
      toDate: '2026-03-15',
      dimensions: { '6': 'H1' },
      budgetId: 'b1',
    })

    expect(mockLoadBudget).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      budgetId: 'b1',
      fiscalPeriodId: 'period-1',
      period: { start: '2026-01-01', end: '2026-12-31' },
      window: { from: '2026-01-01', to: '2026-03-15' },
      dimensions: { '6': 'H1' },
    })
    expect(report.budget?.applied).toBe(false)
    expect(report.groups[0]!.rows[0]!.budget).toBeUndefined()
    expect(report.net_result_budget).toBeUndefined()
  })

  it('reads no budget when none is asked for', async () => {
    queued = { fiscal_periods: [{ data: PERIOD, error: null }] }
    mockTrialBalance.mockResolvedValue(tb([tbRow({ period_credit: 5000 })]))
    const report = await generateResultatrapport(client(), 'company-1', 'period-1')
    expect(mockLoadBudget).not.toHaveBeenCalled()
    expect(report.budget).toBeUndefined()
    expect(report.groups[0]!.rows[0]).not.toHaveProperty('budget')
  })
})

describe('generateDimensionPnl with a budget', () => {
  it('gives each value column its budget, a column for a value only budgeted, and the untagged budget its own', async () => {
    queued = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: { id: 'd6', sie_dim_no: 6, name: 'Projekt' }, error: null }],
      dimension_values: [{ data: [], error: null }],
      buckets: [{ data: [{ account_number: '3001', code: 'H1', debit: 0, credit: 1000 }], error: null }],
    }
    mockTrialBalance.mockResolvedValue(tb([tbRow({ account_number: '3001', period_credit: 1000 })]))
    mockLoadBudget.mockResolvedValue(
      loaded(
        { '3001': 1500, '5010': -200 },
        {
          byAccountCode: new Map([
            ['3001', new Map([['H1', 900], ['H2', 600]])],
            ['5010', new Map([['', -200]])],
          ]),
        },
      ),
    )

    const report = await generateDimensionPnl(client(), 'company-1', 'period-1', '6', { budgetId: 'b1' })

    expect(mockLoadBudget).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ groupDim: '6' }))
    expect(report.columns.map((c) => c.code)).toEqual(['H1', 'H2', null])
    const revenue = report.groups.find((g) => g.class === 3)!
    expect(revenue.rows[0]).toMatchObject({ values: [1000, 0, 0], total: 1000, budget_values: [900, 600, 0], budget_total: 1500 })
    const rent = report.groups.find((g) => g.class === 5)!
    expect(rent.rows[0]).toMatchObject({ account_name: 'Lokalhyra', values: [0, 0, 0], total: 0, budget_values: [0, 0, -200], budget_total: -200 })
    expect(report.budget_net_per_column).toEqual([900, 600, -200])
    expect(report.budget_net_total).toBe(1300)

    // The page's toggle and the export's sheets: Budget, and Avvikelse = utfall - budget.
    expect(dimensionPnlMeasure(report, 'budget').net_per_column).toEqual([900, 600, -200])
    const deviation = dimensionPnlMeasure(report, 'deviation')
    expect(deviation.net_per_column).toEqual([100, -600, 200])
    expect(deviation.net_total).toBe(-300)
    expect(dimensionPnlMeasure(report, 'actual')).toBe(report)
  })

  it('keeps a row whose budget cancels out over the values', async () => {
    queued = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: { id: 'd6', sie_dim_no: 6, name: 'Projekt' }, error: null }],
      dimension_values: [{ data: [], error: null }],
      buckets: [{ data: [], error: null }],
    }
    mockTrialBalance.mockResolvedValue(tb([]))
    mockLoadBudget.mockResolvedValue(
      loaded({ '5010': 0 }, { byAccountCode: new Map([['5010', new Map([['H1', 1000], ['H2', -1000]])]]) }),
    )
    const report = await generateDimensionPnl(client(), 'company-1', 'period-1', '6', { budgetId: 'b1' })
    expect(report.groups.find((g) => g.class === 5)?.rows[0]).toMatchObject({ budget_values: [1000, -1000], budget_total: 0 })
    expect(report.budget_net_per_column).toEqual([1000, -1000])
  })
})
