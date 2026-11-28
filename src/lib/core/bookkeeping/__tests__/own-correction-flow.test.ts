/**
 * A rättelse of a verifikat a register names goes through the register's own
 * flow while that flow can act: the year's opening balance (Korrigera
 * ingående balanser), a booked salary run's verifikat (Korrigera
 * lönekörning) and a planenlig avskrivning (Återför, then the register books
 * the year again). Moved out of a locked year, and in every state the flow
 * itself refuses, the generic rättelse stays allowed. Every other verifikat
 * passes with no read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import {
  BookkeepingDatabaseError,
  DepreciationCorrectionOwnFlowError,
  OpeningBalanceCorrectionOwnFlowError,
  SalaryRunCorrectionOwnFlowError,
} from '@/lib/bookkeeping/errors'
import { classifyError } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { assertNoOwnCorrectionFlow } from '../own-correction-flow'

const COMPANY = 'company-1'
const OPEN = { moved: false }
const MOVED = { moved: true }

const YEAR_2026 = {
  id: 'fp-2026',
  company_id: COMPANY,
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
  opening_balances_set: true,
  opening_balance_entry_id: 'je-ib',
}

beforeEach(() => vi.clearAllMocks())

describe('a verifikat no register names', () => {
  it.each(['manual', 'bank_transaction', 'invoice_cash_payment', 'correction', null])(
    '%s passes with no read',
    async (sourceType) => {
      const { supabase, tables } = createRowsMockSupabase({})
      await expect(
        assertNoOwnCorrectionFlow(supabase as never, COMPANY, { id: 'je-1', entry_date: '2026-03-10', source_type: sourceType }, OPEN),
      ).resolves.toBeUndefined()
      expect(tables()).toEqual([])
    },
  )
})

describe('the year\'s opening balance', () => {
  const ib = { id: 'je-ib', entry_date: '2026-01-01', source_type: 'opening_balance', source_id: null }

  it('is refused in an open year, naming the year', async () => {
    const { supabase } = createRowsMockSupabase({ fiscal_periods: [{ ...YEAR_2026 }], journal_entries: [] })
    const refusal = assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, OPEN)
    await expect(refusal).rejects.toBeInstanceOf(OpeningBalanceCorrectionOwnFlowError)
    await expect(refusal).rejects.toMatchObject({ code: 'OPENING_BALANCE_CORRECTION_OWN_FLOW', fiscalPeriodId: 'fp-2026' })
  })

  it('is allowed when the correction would be moved (never reached for an IB: its date is fixed)', async () => {
    const { supabase, tables } = createRowsMockSupabase({ fiscal_periods: [{ ...YEAR_2026 }] })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, MOVED)).resolves.toBeUndefined()
    expect(tables()).toEqual([])
  })

  it('is allowed once a bokslut is posted in the year: Korrigera ingående balanser refuses until it is reversed', async () => {
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: [{ ...YEAR_2026 }],
      journal_entries: [
        { id: 'je-close', company_id: COMPANY, fiscal_period_id: 'fp-2026', source_type: 'year_end', status: 'posted' },
      ],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, OPEN)).resolves.toBeUndefined()
  })

  it('is refused when the year\'s only year_end verifikat is reversed', async () => {
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: [{ ...YEAR_2026 }],
      journal_entries: [
        { id: 'je-close', company_id: COMPANY, fiscal_period_id: 'fp-2026', source_type: 'year_end', status: 'reversed' },
      ],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, OPEN)).rejects.toBeInstanceOf(
      OpeningBalanceCorrectionOwnFlowError,
    )
  })

  it('is allowed when no year names it (an IB booked without the pointer, or one already replaced)', async () => {
    const unlinked = createRowsMockSupabase({ fiscal_periods: [{ ...YEAR_2026, opening_balance_entry_id: 'je-other' }] })
    await expect(assertNoOwnCorrectionFlow(unlinked.supabase as never, COMPANY, ib, OPEN)).resolves.toBeUndefined()
    const notSet = createRowsMockSupabase({ fiscal_periods: [{ ...YEAR_2026, opening_balances_set: false }] })
    await expect(assertNoOwnCorrectionFlow(notSet.supabase as never, COMPANY, ib, OPEN)).resolves.toBeUndefined()
  })

  it('is allowed when the year\'s first day is behind the company lock date though the verifikat\'s own day is not', async () => {
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: [{ ...YEAR_2026 }],
      journal_entries: [],
      company_settings: [{ company_id: COMPANY, bookkeeping_locked_through: '2026-01-01' }],
    })
    const lateIb = { ...ib, entry_date: '2026-01-02' }
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, lateIb, OPEN)).resolves.toBeUndefined()
  })

  it('reads company-scoped, by the pointer', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ fiscal_periods: [], journal_entries: [] })
    await assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, OPEN)
    expect(findCalls('fiscal_periods', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['opening_balance_entry_id', 'je-ib'],
    ])
  })

  it('throws on a failed read: unknown is never let through', async () => {
    const { supabase } = createTableMockSupabase({ fiscal_periods: { data: null, error: { message: 'boom' } } })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, ib, OPEN)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
  })
})

describe('a booked salary run\'s verifikat', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    id: 'run-1',
    company_id: COMPANY,
    status: 'booked',
    salary_entry_id: 'je-salary',
    avgifter_entry_id: 'je-avgifter',
    vacation_entry_id: null,
    pension_entry_id: null,
    ...overrides,
  })
  const entry = (id: string, entryDate = '2026-03-25', status = 'posted') => ({
    id,
    company_id: COMPANY,
    entry_date: entryDate,
    status,
  })
  const voucher = (id = 'je-salary', sourceId: string | null = 'run-1') => ({
    id,
    entry_date: '2026-03-25',
    source_type: 'salary_payment',
    source_id: sourceId,
  })

  it.each(['je-salary', 'je-avgifter'])('%s is refused in an open year, naming the run', async (id) => {
    const { supabase, tables } = createRowsMockSupabase({
      salary_runs: [run()],
      journal_entries: [entry('je-salary'), entry('je-avgifter')],
    })
    const refusal = assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(id), OPEN)
    await expect(refusal).rejects.toBeInstanceOf(SalaryRunCorrectionOwnFlowError)
    await expect(refusal).rejects.toMatchObject({ code: 'SALARY_RUN_CORRECTION_OWN_FLOW', salaryRunId: 'run-1' })
    // Every verifikat of the run is on the payment date, which is open: no lock read.
    expect(tables()).toEqual(['salary_runs', 'journal_entries'])
  })

  it('is allowed when the correction is moved out of a locked year: Korrigera lönekörning cannot reverse there', async () => {
    const { supabase, tables } = createRowsMockSupabase({ salary_runs: [run()] })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), MOVED)).resolves.toBeUndefined()
    expect(tables()).toEqual([])
  })

  it.each(['paid', 'approved', 'corrected'])('is allowed for a %s run: Korrigera lönekörning corrects booked runs only', async (status) => {
    const { supabase } = createRowsMockSupabase({ salary_runs: [run({ status })], journal_entries: [entry('je-salary')] })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), OPEN)).resolves.toBeUndefined()
  })

  it('is allowed for a verifikat the run does not name, or one that names no run', async () => {
    const { supabase } = createRowsMockSupabase({ salary_runs: [run()], journal_entries: [] })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher('je-stray'), OPEN)).resolves.toBeUndefined()
    await expect(
      assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher('je-closure', 'closure-1'), OPEN),
    ).resolves.toBeUndefined()
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher('je-none', null), OPEN)).resolves.toBeUndefined()
  })

  it('is allowed when another verifikat of the run is behind a lock: Korrigera lönekörning would stop at it', async () => {
    const { supabase } = createRowsMockSupabase({
      salary_runs: [run()],
      journal_entries: [entry('je-salary'), entry('je-avgifter', '2026-02-28')],
      company_settings: [{ company_id: COMPANY, bookkeeping_locked_through: '2026-02-28' }],
      fiscal_periods: [{ ...YEAR_2026 }],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), OPEN)).resolves.toBeUndefined()
  })

  it('is refused when the run\'s other verifikat lie on another open day', async () => {
    const { supabase } = createRowsMockSupabase({
      salary_runs: [run()],
      journal_entries: [entry('je-salary'), entry('je-avgifter', '2026-03-31')],
      company_settings: [{ company_id: COMPANY, bookkeeping_locked_through: '2026-02-28' }],
      fiscal_periods: [{ ...YEAR_2026 }],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), OPEN)).rejects.toBeInstanceOf(
      SalaryRunCorrectionOwnFlowError,
    )
  })

  it('reads company-scoped, by the run id the verifikat names', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ salary_runs: [] })
    await assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), OPEN)
    expect(findCalls('salary_runs', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['id', 'run-1'],
    ])
  })

  it('throws on a failed read: unknown is never let through', async () => {
    const { supabase } = createTableMockSupabase({ salary_runs: { data: null, error: { message: 'boom' } } })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, voucher(), OPEN)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
  })
})

describe('a planenlig avskrivning in the asset register', () => {
  const depreciation = { id: 'je-dep', entry_date: '2026-12-31', source_type: 'year_end', source_id: null }

  it('is refused in an open year, naming the asset', async () => {
    const { supabase } = createRowsMockSupabase({
      depreciation_schedules: [{ id: 'ds-1', company_id: COMPANY, asset_id: 'asset-1', journal_entry_id: 'je-dep' }],
    })
    const refusal = assertNoOwnCorrectionFlow(supabase as never, COMPANY, depreciation, OPEN)
    await expect(refusal).rejects.toBeInstanceOf(DepreciationCorrectionOwnFlowError)
    await expect(refusal).rejects.toMatchObject({ code: 'DEPRECIATION_CORRECTION_OWN_FLOW', assetId: 'asset-1' })
  })

  it('is allowed when the correction would be moved (never reached for year_end: its date is fixed)', async () => {
    const { supabase, tables } = createRowsMockSupabase({
      depreciation_schedules: [{ id: 'ds-1', company_id: COMPANY, asset_id: 'asset-1', journal_entry_id: 'je-dep' }],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, depreciation, MOVED)).resolves.toBeUndefined()
    expect(tables()).toEqual([])
  })

  it('is allowed for a year_end verifikat the register does not name (a bokslut)', async () => {
    const { supabase } = createRowsMockSupabase({
      depreciation_schedules: [{ id: 'ds-1', company_id: COMPANY, asset_id: 'asset-1', journal_entry_id: 'je-other' }],
    })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, depreciation, OPEN)).resolves.toBeUndefined()
  })

  it('throws on a failed read: unknown is never let through', async () => {
    const { supabase } = createTableMockSupabase({ depreciation_schedules: { data: null, error: { message: 'boom' } } })
    await expect(assertNoOwnCorrectionFlow(supabase as never, COMPANY, depreciation, OPEN)).rejects.toBeInstanceOf(
      BookkeepingDatabaseError,
    )
  })
})

describe('the refusals as every door answers them', () => {
  it.each([
    [new OpeningBalanceCorrectionOwnFlowError('fp-2026'), { fiscalPeriodId: 'fp-2026' }, /Korrigera ingående balanser/, /Correct opening balances/],
    [new SalaryRunCorrectionOwnFlowError('run-1'), { salaryRunId: 'run-1' }, /Korrigera lönekörning/, /Correct payroll run/],
    [new DepreciationCorrectionOwnFlowError('asset-1'), { assetId: 'asset-1' }, /Återför det.*Bokslut/, /Reverse it.*Year-end/],
  ])('%s: its own code, details, a 409 and the step that works', (error, details, sv, en) => {
    expect(classifyError(error)).toMatchObject({ code: error.code, details })
    expect(getErrorEntry(error.code)?.httpStatus).toBe(409)
    expect(getErrorMessage(error)).toMatch(sv)
    expect(getErrorMessage(error, { locale: 'en' })).toMatch(en)
  })
})
