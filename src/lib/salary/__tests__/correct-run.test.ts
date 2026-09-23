/**
 * Tests for the shared salary-run correction orchestration
 * (lib/salary/correct-run.ts): the dashboard correct route's extracted core,
 * shared with the v1 :correct verb. The storno engine, payslip-link
 * revocation and vacation-ledger sync are mocked; the tests pin the
 * preconditions, the order of operations, the partial-failure results and
 * that a dry run writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { CannotReverseNonPostedError, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'

vi.mock('@/lib/bookkeeping/engine', () => ({ reverseEntry: vi.fn() }))
vi.mock('@/lib/salary/payslips/links', () => ({ revokeLinksForRun: vi.fn() }))
vi.mock('@/lib/salary/vacation-ledger', () => ({ syncVacationLedgerForEmployees: vi.fn() }))

import { correctSalaryRun } from '../correct-run'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { revokeLinksForRun } from '@/lib/salary/payslips/links'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'

const ARGS = { companyId: 'company-1', userId: 'user-1', runId: 'run-1' }

const makeBookedRun = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  company_id: 'company-1',
  status: 'booked',
  period_year: 2026,
  period_month: 3,
  payment_date: '2026-03-25',
  voucher_series: 'L',
  deviation_period_start: '2026-02-01',
  deviation_period_end: '2026-02-28',
  salary_entry_id: 'je-salary',
  avgifter_entry_id: 'je-avg',
  vacation_entry_id: 'je-vac',
  pension_entry_id: null,
  ...overrides,
})

const CORRECTION_ROW = {
  id: 'corr-1',
  company_id: 'company-1',
  status: 'draft',
  period_year: 2026,
  period_month: 3,
  payment_date: '2026-03-25',
  voucher_series: 'L',
  deviation_period_start: '2026-02-01',
  deviation_period_end: '2026-02-28',
  is_correction: true,
  corrects_run_id: 'run-1',
  notes: 'Korrigering av lönekörning 2026-03',
}

/**
 * Records the interleaving of supabase table access and the mocked helpers
 * so the tests can assert the storno -> status flip -> revoke -> insert order.
 */
function trackedSupabase() {
  const mock = createQueuedMockSupabase()
  const order: string[] = []
  const original = mock.supabase.from.getMockImplementation()!
  mock.supabase.from.mockImplementation((table: string) => {
    order.push(`from:${table}`)
    return original(table)
  })
  vi.mocked(reverseEntry).mockImplementation(async (_s, _c, _u, entryId: string) => {
    order.push(`reverse:${entryId}`)
    return { id: `storno-${entryId}` } as never
  })
  vi.mocked(revokeLinksForRun).mockImplementation(async () => {
    order.push('revoke')
  })
  vi.mocked(syncVacationLedgerForEmployees).mockImplementation(async () => {
    order.push('sync')
    return { ok: true }
  })
  return { ...mock, order }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('correctSalaryRun preconditions', () => {
  it('returns SALARY_RUN_NOT_FOUND for an unknown run and writes nothing', async () => {
    const { supabase, enqueue, findCall, calls } = trackedSupabase()
    enqueue({ data: null })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    expect(findCall('salary_runs', 'eq')).toEqual(['id', 'run-1'])
    expect(calls.some((c) => c.table === 'salary_runs' && c.method === 'eq' && c.args[0] === 'company_id')).toBe(true)
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('passes a load error through as DB_ERROR at stage load_run', async () => {
    const { supabase, enqueue } = trackedSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR', stage: 'load_run' })
    expect(reverseEntry).not.toHaveBeenCalled()
  })

  it('returns SALARY_RUN_CORRECT_NOT_BOOKED with the current status', async () => {
    const { supabase, enqueue, calls } = trackedSupabase()
    enqueue({ data: makeBookedRun({ status: 'paid' }) })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_CORRECT_NOT_BOOKED',
      details: { current_status: 'paid' },
    })
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('returns SALARY_RUN_ALREADY_CORRECTED pointing at the live correction run', async () => {
    const { supabase, enqueueMany, calls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ status: 'corrected' }) },
      { data: { id: 'corr-existing' } }, // lookup of the correction run
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_ALREADY_CORRECTED',
      details: { current_status: 'corrected', correction_run_id: 'corr-existing', reason: 'status_corrected' },
    })
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'corrects_run_id' && c.args[1] === 'run-1')).toBe(true)
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })
})

describe('correctSalaryRun dry run', () => {
  it('returns the preview and performs no writes', async () => {
    const { supabase, enqueue, calls, order } = trackedSupabase()
    enqueue({ data: makeBookedRun() })

    const result = await correctSalaryRun(supabase as never, { ...ARGS, dryRun: true })

    expect(result).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        original_run: {
          id: 'run-1',
          status: 'booked',
          period_year: 2026,
          period_month: 3,
          payment_date: '2026-03-25',
          voucher_series: 'L',
          deviation_period_start: '2026-02-01',
          deviation_period_end: '2026-02-28',
        },
        entries_to_reverse: ['je-salary', 'je-avg', 'je-vac'],
        correction_run: {
          period_year: 2026,
          period_month: 3,
          payment_date: '2026-03-25',
          voucher_series: 'L',
          deviation_period_start: '2026-02-01',
          deviation_period_end: '2026-02-28',
          status: 'draft',
          is_correction: true,
          corrects_run_id: 'run-1',
        },
      },
    })
    expect(order).toEqual(['from:salary_runs'])
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(syncVacationLedgerForEmployees).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })
})

describe('correctSalaryRun live', () => {
  it('stornos every entry, flips the original, revokes links, inserts the correction, copies the roster, syncs the ledger, in that order', async () => {
    const { supabase, enqueueMany, calls, findCalls, order } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null }, // update original -> corrected
      { data: CORRECTION_ROW }, // insert correction run
      {
        data: [
          {
            id: 'sre-1',
            employee_id: 'emp-1',
            employment_degree: 100,
            monthly_salary: 30000,
            salary_type: 'monthly',
            hours_worked: null,
            tax_table_number: 30,
            tax_column: 1,
            line_items: [
              {
                item_type: 'salary',
                description: 'Månadslön',
                quantity: 1,
                unit_price: 30000,
                amount: 30000,
                is_taxable: true,
                is_avgift_basis: true,
                is_vacation_basis: true,
                is_gross_deduction: false,
                is_net_deduction: false,
                account_number: '7210',
                sort_order: 1,
                source_benefit_id: null,
                source_recurring_line_id: 'rec-9',
              },
            ],
          },
        ],
      },
      { data: { id: 'sre-new' } }, // insert copied employee
      { data: null }, // insert copied line item
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      originalRunId: 'run-1',
      correctionRun: CORRECTION_ROW,
      reversedEntryIds: ['je-salary', 'je-avg', 'je-vac'],
      warnings: [],
    })
    expect((result as { stampedAt: string }).stampedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(order).toEqual([
      'from:salary_runs',
      'reverse:je-salary',
      'reverse:je-avg',
      'reverse:je-vac',
      'from:salary_runs',
      'revoke',
      'from:salary_runs',
      'from:salary_run_employees',
      'from:salary_run_employees',
      'from:salary_line_items',
      'sync',
    ])
    expect(reverseEntry).toHaveBeenCalledTimes(3)
    expect(reverseEntry).toHaveBeenNthCalledWith(1, supabase, 'company-1', 'user-1', 'je-salary')
    expect(revokeLinksForRun).toHaveBeenCalledWith(supabase, 'run-1')
    expect(syncVacationLedgerForEmployees).toHaveBeenCalledWith(supabase, 'company-1', ['emp-1'])

    // Status flip is company-scoped.
    expect(findCalls('salary_runs', 'update')).toEqual([[{ status: 'corrected' }]])
    const updateIdx = calls.findIndex((c) => c.method === 'update')
    const scopedFlip = calls
      .slice(updateIdx + 1, updateIdx + 3)
      .map((c) => [c.method, ...c.args])
    expect(scopedFlip).toEqual([
      ['eq', 'id', 'run-1'],
      ['eq', 'company_id', 'company-1'],
    ])

    // Correction run copies the period, payment date, deviation window and series.
    const [runInsert, sreInsert, lineInsert] = findCalls('salary_runs', 'insert')
      .concat(findCalls('salary_run_employees', 'insert'), findCalls('salary_line_items', 'insert'))
      .map((args) => args[0] as Record<string, unknown>)
    expect(runInsert).toEqual({
      company_id: 'company-1',
      user_id: 'user-1',
      period_year: 2026,
      period_month: 3,
      payment_date: '2026-03-25',
      deviation_period_start: '2026-02-01',
      deviation_period_end: '2026-02-28',
      voucher_series: 'L',
      is_correction: true,
      corrects_run_id: 'run-1',
      notes: 'Korrigering av lönekörning 2026-03',
    })
    expect(sreInsert).toMatchObject({
      salary_run_id: 'corr-1',
      employee_id: 'emp-1',
      company_id: 'company-1',
      monthly_salary: 30000,
      tax_table_number: 30,
    })
    expect(lineInsert).toMatchObject({
      salary_run_employee_id: 'sre-new',
      company_id: 'company-1',
      item_type: 'salary',
      amount: 30000,
      account_number: '7210',
      source_benefit_id: null,
      source_recurring_line_id: 'rec-9',
    })
  })

  it('skips an entry a concurrent call already reversed and still counts it as reversed', async () => {
    const { supabase, enqueueMany } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ vacation_entry_id: null }) },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [] },
    ])
    vi.mocked(reverseEntry).mockImplementationOnce(async () => {
      throw new EntryAlreadyReversedError()
    })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: true, reversedEntryIds: ['je-salary', 'je-avg'] })
    expect(reverseEntry).toHaveBeenCalledTimes(2)
    expect(revokeLinksForRun).toHaveBeenCalledOnce()
  })

  it('creates the missing correction run when the original is corrected but has no child', async () => {
    // An earlier call reversed the entries, flipped the status and revoked
    // the links, then failed on the insert. Nothing in the ledger may be
    // touched again; the draft must simply be created.
    const { supabase, enqueueMany, calls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ status: 'corrected', vacation_entry_id: null }) },
      { data: null }, // no correction child yet
      { data: CORRECTION_ROW },
      { data: [] },
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: true, reversedEntryIds: ['je-salary', 'je-avg'] })
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update')).toEqual([])
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(1)
  })

  it('resumes past entries an earlier attempt already reversed', async () => {
    // An earlier call reversed je-salary and then failed further down: that
    // entry is now in status 'reversed', which reverseEntry reports as
    // CannotReverseNonPostedError. The retry must treat it as done.
    const { supabase, enqueueMany } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ vacation_entry_id: null }) },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [] },
    ])
    vi.mocked(reverseEntry).mockImplementationOnce(async () => {
      throw new CannotReverseNonPostedError('reversed')
    })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: true, reversedEntryIds: ['je-salary', 'je-avg'] })
    expect(reverseEntry).toHaveBeenCalledTimes(2)
    expect(revokeLinksForRun).toHaveBeenCalledOnce()
  })

  it('stops at the first storno failure: no status flip, no revoke, no insert', async () => {
    const { supabase, enqueue, calls, order } = trackedSupabase()
    enqueue({ data: makeBookedRun() })
    const boom = new CannotReverseNonPostedError('draft')
    vi.mocked(reverseEntry)
      .mockImplementationOnce(async () => {
        order.push('reverse:je-salary')
        return { id: 'storno-1' } as never
      })
      .mockImplementationOnce(async () => {
        throw boom
      })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'REVERSAL_FAILED',
      error: boom,
      details: { entry_id: 'je-avg', reversed_entry_ids: ['je-salary'], remaining_entry_ids: ['je-vac'] },
    })
    expect(reverseEntry).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['from:salary_runs', 'reverse:je-salary'])
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('maps a unique-index conflict on the insert to SALARY_RUN_ALREADY_CORRECTED (period_conflict)', async () => {
    const { supabase, enqueueMany, order } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: null, error: { code: '23505', message: 'duplicate key' } },
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_ALREADY_CORRECTED',
      details: { current_status: 'corrected', correction_run_id: null, reason: 'period_conflict' },
    })
    // The storno, status flip and revoke had already happened (documented partial state).
    expect(order).toEqual([
      'from:salary_runs',
      'reverse:je-salary',
      'reverse:je-avg',
      'reverse:je-vac',
      'from:salary_runs',
      'revoke',
      'from:salary_runs',
    ])
    expect(syncVacationLedgerForEmployees).not.toHaveBeenCalled()
  })

  it('passes any other insert error through as DB_ERROR at stage insert_correction_run', async () => {
    const { supabase, enqueueMany } = trackedSupabase()
    const dbError = { code: '42501', message: 'permission denied' }
    enqueueMany([{ data: makeBookedRun() }, { data: null }, { data: null, error: dbError }])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'DB_ERROR', stage: 'insert_correction_run', error: dbError })
  })

  it('reports a failed vacation-ledger sync as a warning, not a failure', async () => {
    const { supabase, enqueueMany } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [{ id: 'sre-1', employee_id: 'emp-1', line_items: [] }] },
      { data: { id: 'sre-new' } },
    ])
    vi.mocked(syncVacationLedgerForEmployees).mockResolvedValue({ ok: false, message: 'ledger boom' })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({
      ok: true,
      warnings: ['vacation ledger sync failed: ledger boom'],
    })
  })
})
