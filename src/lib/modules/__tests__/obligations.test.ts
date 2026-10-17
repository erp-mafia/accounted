import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { PACKAGES } from '../packages'
import {
  loadOpenObligations,
  OBLIGATION_CODES,
  OBLIGATION_LABELS,
  obligationsPhraseEn,
  obligationsPhraseSv,
  PACKAGE_OBLIGATIONS,
  probePackageObligations,
} from '../obligations'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const TODAY = '2026-10-16'

type Chain = Parameters<TableMockResolver>[0]

/** The value of the first `method(column, value)` call on a chain. */
function arg(chain: Chain, method: string, column: string): unknown {
  return chain.find((c) => c.method === method && c.args[0] === column)?.args[1]
}

function supabaseWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return { supabase: mock.supabase as unknown as SupabaseClient, mock }
}

describe('obligation catalogue', () => {
  it('gives every switchable package its obligations, and every obligation one package and a label', () => {
    const switchable = PACKAGES.filter((p) => p.switchable).map((p) => p.id).sort()
    expect(Object.keys(PACKAGE_OBLIGATIONS).sort()).toEqual(switchable)
    const listed = Object.values(PACKAGE_OBLIGATIONS).flat()
    expect([...listed].sort()).toEqual([...OBLIGATION_CODES].sort())
    expect(new Set(listed).size).toBe(listed.length)
    for (const code of OBLIGATION_CODES) {
      expect(OBLIGATION_LABELS[code].sv.length, code).toBeGreaterThan(0)
      expect(OBLIGATION_LABELS[code].en.length, code).toBeGreaterThan(0)
    }
  })

  it('joins the obligations into one phrase per language and ignores codes it does not know', () => {
    expect(obligationsPhraseSv(['unpaid_customer_invoices', 'active_recurring_invoices', 'open_collection_cases'])).toBe(
      'obetalda kundfakturor, aktiva återkommande fakturor och öppna inkassoärenden',
    )
    expect(obligationsPhraseEn(['open_salary_runs', 'unfiled_agi'])).toBe(
      'salary runs not yet paid and booked and employer declarations (AGI) not yet filed',
    )
    expect(obligationsPhraseSv(['something_new'])).toBe('')
  })
})

describe('probePackageObligations', () => {
  it('finds nothing open when every table is empty', async () => {
    for (const pkg of PACKAGES.filter((p) => p.switchable)) {
      const { supabase } = supabaseWith({})
      expect(await probePackageObligations(supabase, COMPANY_ID, pkg.id as never, { today: TODAY }), pkg.id).toEqual([])
    }
  })

  it('scopes every read to the company', async () => {
    const { supabase, mock } = supabaseWith({})
    await loadOpenObligations(supabase, COMPANY_ID, PACKAGES.map((p) => p.id), { today: TODAY })
    for (const table of new Set(mock.tables())) {
      const companyFilters = mock.findCalls(table, 'eq').filter((args) => args[0] === 'company_id')
      expect(companyFilters.length, table).toBeGreaterThan(0)
      for (const args of companyFilters) expect(args[1], table).toBe(COMPANY_ID)
    }
  })

  it('names an open salary run, an unfiled AGI and an unmatched payout for Lön', async () => {
    const salaryRuns: TableMockResolver = (chain) => {
      const statuses = arg(chain, 'in', 'status') as string[] | undefined
      if (statuses?.includes('draft')) return { data: [{ id: 'draft-run' }] }
      if (statuses?.includes('booked')) {
        return { data: [{ id: 'run-sep', period_year: 2026, period_month: 9, payment_date: '2026-09-25' }] }
      }
      if (arg(chain, 'eq', 'status') === 'booked') {
        return {
          data: [{ id: 'run-sep', period_year: 2026, period_month: 9, payment_date: '2026-09-25', salary_entry_id: 'je-sep' }],
        }
      }
      return { data: [] }
    }
    const transactions: TableMockResolver = (chain) =>
      chain.some((c) => c.method === 'gte' && c.args[0] === 'date') ? { data: [{ id: 'tx-1' }] } : { data: [] }
    const { supabase } = supabaseWith({
      salary_runs: salaryRuns,
      agi_declarations: { data: [] },
      deadlines: { data: [] },
      transactions,
    })
    expect(await probePackageObligations(supabase, COMPANY_ID, 'payroll', { today: TODAY })).toEqual([
      'open_salary_runs',
      'unfiled_agi',
      'unmatched_salary_payments',
    ])
  })

  it('counts an AGI as filed by its declaration or by the completed deadline of the payout month', async () => {
    const run = { id: 'run-sep', period_year: 2026, period_month: 8, payment_date: '2026-09-25' }
    const salaryRuns: TableMockResolver = (chain) =>
      (arg(chain, 'in', 'status') as string[] | undefined)?.includes('booked') ? { data: [run] } : { data: [] }

    const byDeclaration = supabaseWith({
      salary_runs: salaryRuns,
      agi_declarations: { data: [{ salary_run_id: 'run-sep' }] },
      deadlines: { data: [] },
    })
    expect(await probePackageObligations(byDeclaration.supabase, COMPANY_ID, 'payroll', { today: TODAY })).toEqual([])

    const byDeadline = supabaseWith({
      salary_runs: salaryRuns,
      agi_declarations: { data: [] },
      deadlines: { data: [{ tax_period: '2026-09' }] },
    })
    expect(await probePackageObligations(byDeadline.supabase, COMPANY_ID, 'payroll', { today: TODAY })).toEqual([])
    // The deadline is looked up by the payout month (the redovisningsperiod), not the earned month.
    expect(byDeadline.mock.findCall('deadlines', 'in')).toEqual(['tax_period', ['2026-09']])
    // Only recent payouts: older periods are the deadline calendar's.
    expect(byDeadline.mock.findCall('salary_runs', 'gte')).toEqual(['payment_date', '2026-07-16'])
  })

  it('leaves a booked payout unmatched only once the bank lines for its date have arrived', async () => {
    const salaryRuns: TableMockResolver = (chain) =>
      arg(chain, 'eq', 'status') === 'booked'
        ? { data: [{ id: 'run-1', period_year: 2026, period_month: 10, payment_date: '2026-10-15', salary_entry_id: 'je-1' }] }
        : { data: [] }
    const noLinesYet = supabaseWith({ salary_runs: salaryRuns, transactions: { data: [] } })
    expect(await probePackageObligations(noLinesYet.supabase, COMPANY_ID, 'payroll', { today: TODAY })).toEqual([])

    const matched = supabaseWith({
      salary_runs: salaryRuns,
      transactions: (chain) =>
        chain.some((c) => c.method === 'in' && c.args[0] === 'journal_entry_id')
          ? { data: [{ journal_entry_id: 'je-1' }] }
          : { data: [{ id: 'tx-1' }] },
    })
    expect(await probePackageObligations(matched.supabase, COMPANY_ID, 'payroll', { today: TODAY })).toEqual([])
  })

  it('keeps Inventarier open while an asset has depreciation left to post, not once it is fully depreciated', async () => {
    const asset = { id: 'a1', acquisition_cost: 30000, salvage_value: 0, opening_accumulated_depreciation: 6000 }
    const left = supabaseWith({
      assets: { data: [asset] },
      depreciation_schedules: { data: [{ asset_id: 'a1', planned_depreciation: 6000 }] },
    })
    expect(await probePackageObligations(left.supabase, COMPANY_ID, 'assets', { today: TODAY })).toEqual(['active_assets'])

    const done = supabaseWith({
      assets: { data: [asset] },
      depreciation_schedules: {
        data: [
          { asset_id: 'a1', planned_depreciation: 12000 },
          { asset_id: 'a1', planned_depreciation: 12000 },
        ],
      },
    })
    expect(await probePackageObligations(done.supabase, COMPANY_ID, 'assets', { today: TODAY })).toEqual([])
    // Only posted depreciation counts.
    expect(done.mock.findCall('depreciation_schedules', 'not')).toEqual(['journal_entry_id', 'is', null])
  })

  it('finds open invoices, connections and unbooked days', async () => {
    const { supabase } = supabaseWith({
      invoices: { data: [{ id: 'i1' }] },
      pos_sales_days: { data: [{ id: 'd1' }] },
      shopify_connections: { data: [{ id: 's1' }] },
    })
    expect(await probePackageObligations(supabase, COMPANY_ID, 'customer-invoices', { today: TODAY })).toEqual([
      'unpaid_customer_invoices',
    ])
    expect(await probePackageObligations(supabase, COMPANY_ID, 'pos-and-webshop', { today: TODAY })).toEqual([
      'unbooked_pos_days',
      'active_webshop_connection',
    ])
  })

  it('counts an obligation whose read fails as open', async () => {
    const { supabase } = supabaseWith({ expense_claims: { data: null, error: { message: 'down' } } })
    expect(await probePackageObligations(supabase, COMPANY_ID, 'expenses', { today: TODAY })).toEqual([
      'unpaid_expense_claims',
    ])
  })
})

describe('loadOpenObligations', () => {
  it('answers every requested switchable package and skips Bokföring', async () => {
    const { supabase, mock } = supabaseWith({ expense_claims: { data: [{ id: 'e1' }] } })
    const result = await loadOpenObligations(supabase, COMPANY_ID, ['bookkeeping', 'expenses', 'bank'], { today: TODAY })
    expect(result).toEqual({ expenses: ['unpaid_expense_claims'], bank: [] })
    expect(mock.tables()).not.toContain('salary_runs')
  })

  it('reads nothing when no package is asked about', async () => {
    const { supabase, mock } = supabaseWith({})
    expect(await loadOpenObligations(supabase, COMPANY_ID, [])).toEqual({})
    expect(mock.tables()).toEqual([])
  })
})
