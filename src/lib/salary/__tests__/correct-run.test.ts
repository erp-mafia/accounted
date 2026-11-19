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
import { isAutomaticVacationLine, isCalculatedLine } from '../calculated-line-items'
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
    const { supabase, enqueueMany, calls, order } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: [{ id: 'je-salary', status: 'posted' }, { id: 'je-avg', status: 'posted' }, { id: 'je-vac', status: 'posted' }] },
    ])

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
    expect(order).toEqual(['from:salary_runs', 'from:journal_entries'])
    expect(reverseEntry).not.toHaveBeenCalled()
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(syncVacationLedgerForEmployees).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('previews the rättelse that replaced a user-corrected entry instead of the reversed original', async () => {
    const { supabase, enqueueMany, calls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: [{ id: 'je-salary', status: 'reversed' }, { id: 'je-avg', status: 'posted' }, { id: 'je-vac', status: 'posted' }] },
      { data: [{ id: 'je-rattelse', status: 'posted' }] }, // rättelser of je-salary
    ])

    const result = await correctSalaryRun(supabase as never, { ...ARGS, dryRun: true })

    expect(result).toMatchObject({ ok: true, dryRun: true, preview: { entries_to_reverse: ['je-rattelse', 'je-avg', 'je-vac'] } })
    expect(calls.find((c) => c.table === 'journal_entries' && c.method === 'in' && c.args[0] === 'correction_of_id')?.args)
      .toEqual(['correction_of_id', ['je-salary']])
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
  })

  it('passes a failed verifikat read through as DB_ERROR at stage load_run', async () => {
    const { supabase, enqueueMany } = trackedSupabase()
    enqueueMany([{ data: makeBookedRun() }, { data: null, error: { message: 'connection reset' } }])

    const result = await correctSalaryRun(supabase as never, { ...ARGS, dryRun: true })

    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR', stage: 'load_run' })
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
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] }, // bulk insert of the copied roster
      { data: null }, // bulk insert of the copied line items
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
    expect(sreInsert).toHaveLength(1)
    expect((sreInsert as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
      salary_run_id: 'corr-1',
      employee_id: 'emp-1',
      company_id: 'company-1',
      monthly_salary: 30000,
      tax_table_number: 30,
    })
    expect(lineInsert).toHaveLength(1)
    expect((lineInsert as unknown as Array<Record<string, unknown>>)[0]).toMatchObject({
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
      { data: [] }, // no rättelse replaced je-salary
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
      { data: [] }, // no rättelse replaced je-salary
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

  it('stornos the posted rättelse of a user-corrected entry, so the correction run does not book the period twice', async () => {
    // A user corrected the salary verifikat with storno + rättelse before the
    // run was corrected: the run still points at the reversed original, and
    // the pay lives on in the rättelse (seen 2026-09: both stayed posted next
    // to the correction run's new verifikat).
    const { supabase, enqueueMany, calls, order } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ vacation_entry_id: null }) },
      { data: [{ id: 'je-rattelse', status: 'posted' }] }, // rättelser of je-salary
      { data: null },
      { data: CORRECTION_ROW },
      { data: [] },
    ])
    vi.mocked(reverseEntry).mockImplementationOnce(async () => {
      throw new CannotReverseNonPostedError('reversed')
    })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: true, reversedEntryIds: ['je-salary', 'je-rattelse', 'je-avg'] })
    expect(vi.mocked(reverseEntry).mock.calls.map((call) => call[3])).toEqual(['je-salary', 'je-rattelse', 'je-avg'])
    expect(calls.find((c) => c.table === 'journal_entries' && c.method === 'eq' && c.args[0] === 'company_id')?.args)
      .toEqual(['company_id', 'company-1'])
    expect(order.indexOf('reverse:je-rattelse')).toBeLessThan(order.indexOf('revoke'))
  })

  it('follows a rättelse of a rättelse down to the verifikat posted now', async () => {
    const { supabase, enqueueMany } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun({ vacation_entry_id: null }) },
      { data: [{ id: 'je-r1', status: 'reversed' }] }, // rättelser of je-salary
      { data: [{ id: 'je-r2', status: 'posted' }] }, // rättelser of je-r1
      { data: null },
      { data: CORRECTION_ROW },
      { data: [] },
    ])
    vi.mocked(reverseEntry).mockImplementationOnce(async () => {
      throw new CannotReverseNonPostedError('reversed')
    })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({ ok: true, reversedEntryIds: ['je-salary', 'je-r2', 'je-avg'] })
    expect(vi.mocked(reverseEntry).mock.calls.map((call) => call[3])).toEqual(['je-salary', 'je-r2', 'je-avg'])
  })

  it('stops as REVERSAL_FAILED on the entry whose rättelser cannot be read', async () => {
    const { supabase, enqueueMany, calls } = trackedSupabase()
    const lookupError = { message: 'connection reset' }
    enqueueMany([
      { data: makeBookedRun({ vacation_entry_id: null }) },
      { data: null, error: lookupError },
    ])
    vi.mocked(reverseEntry).mockImplementationOnce(async () => {
      throw new CannotReverseNonPostedError('reversed')
    })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'REVERSAL_FAILED',
      error: lookupError,
      details: { entry_id: 'je-salary', reversed_entry_ids: [], remaining_entry_ids: ['je-avg'] },
    })
    expect(revokeLinksForRun).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'update' || c.method === 'insert')).toEqual([])
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
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
    ])
    vi.mocked(syncVacationLedgerForEmployees).mockResolvedValue({ ok: false, message: 'ledger boom' })

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toMatchObject({
      ok: true,
      warnings: ['vacation ledger sync failed: ledger boom'],
    })
  })
})

describe('correctSalaryRun roster copy', () => {
  // A roster row and its lines as `select('*, line_items:salary_line_items(*)')`
  // returns them, including columns the copy never named one by one.
  const ORIGINAL_EMPLOYEE = {
    id: 'sre-1',
    salary_run_id: 'run-1',
    employee_id: 'emp-1',
    company_id: 'company-1',
    employment_degree: 100,
    monthly_salary: 30000,
    salary_type: 'monthly',
    hours_worked: null,
    tax_table_number: 30,
    tax_column: 1,
    tax_withheld_override: 5000,
    override_reason: 'Jämkning',
    avgifter_category: 'vaxa_stod',
    benefits_adjusted: true,
    removed_from_agi: false,
    calculation_breakdown: { steps: [] },
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-02T00:00:00Z',
    line_items: [
      {
        id: 'li-vac',
        salary_run_employee_id: 'sre-1',
        company_id: 'company-1',
        item_type: 'semesterersattning',
        description: 'Semesterersättning',
        quantity: 1,
        unit_price: null,
        amount: 2400,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: '7285',
        sort_order: 50,
        calculation_source: 'vacation_compensation',
        one_off_tax_percent: null,
        vacation_category: null,
        vacation_saved_year: null,
        source_benefit_id: null,
        source_recurring_line_id: null,
        source_expense_claim_id: null,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-02T00:00:00Z',
      },
      {
        id: 'li-bonus',
        salary_run_employee_id: 'sre-1',
        company_id: 'company-1',
        item_type: 'bonus',
        description: 'Bonus',
        quantity: 1,
        unit_price: 10000,
        amount: 10000,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: '7210',
        sort_order: 10,
        calculation_source: null,
        one_off_tax_percent: 30,
        vacation_category: null,
        vacation_saved_year: null,
        source_benefit_id: null,
        source_recurring_line_id: null,
        source_expense_claim_id: null,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-02T00:00:00Z',
      },
      {
        id: 'li-vacation-day',
        salary_run_employee_id: 'sre-1',
        company_id: 'company-1',
        item_type: 'vacation',
        description: 'Semester, sparade dagar',
        quantity: 2,
        unit_price: null,
        amount: 0,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: null,
        sort_order: 20,
        calculation_source: null,
        one_off_tax_percent: null,
        vacation_category: 'saved',
        vacation_saved_year: '2024',
        source_benefit_id: null,
        source_recurring_line_id: null,
        source_expense_claim_id: null,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-02T00:00:00Z',
      },
      {
        id: 'li-utlagg',
        salary_run_employee_id: 'sre-1',
        company_id: 'company-1',
        item_type: 'expense_reimbursement',
        description: 'Utlägg: tågbiljett',
        quantity: 1,
        unit_price: null,
        amount: 640,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: '2820',
        sort_order: 60,
        calculation_source: null,
        one_off_tax_percent: null,
        vacation_category: null,
        vacation_saved_year: null,
        source_benefit_id: null,
        source_recurring_line_id: null,
        source_expense_claim_id: 'claim-1',
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-02T00:00:00Z',
      },
    ],
  }

  function copiedLines(findCalls: (table: string, method: string) => unknown[][]) {
    const inserts = findCalls('salary_line_items', 'insert')
    expect(inserts).toHaveLength(1) // one bulk insert for the whole roster
    return inserts[0][0] as Array<Record<string, unknown>>
  }

  it('copies every roster and line column except identity, timestamps, the parent link and the calculation proof, one bulk insert each', async () => {
    const { supabase, enqueueMany, findCalls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [ORIGINAL_EMPLOYEE] },
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
      { data: null },
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)
    expect(result).toMatchObject({ ok: true, warnings: [] })

    const rosterInserts = findCalls('salary_run_employees', 'insert')
    expect(rosterInserts).toHaveLength(1)
    // calculation_breakdown is what approve and book check: the correction
    // must be calculated before it can be booked.
    const {
      line_items: _lines,
      id: _id,
      created_at: _c,
      updated_at: _u,
      calculation_breakdown: _breakdown,
      ...employeeColumns
    } = ORIGINAL_EMPLOYEE
    expect(rosterInserts[0][0]).toEqual([{ ...employeeColumns, salary_run_id: 'corr-1' }])

    const lines = copiedLines(findCalls)
    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(line).not.toHaveProperty('id')
      expect(line).not.toHaveProperty('created_at')
      expect(line).not.toHaveProperty('updated_at')
      expect(line.salary_run_employee_id).toBe('sre-new')
      expect(line.company_id).toBe('company-1')
    }
    const byType = Object.fromEntries(lines.map((l) => [l.item_type as string, l]))
    expect(byType.semesterersattning.calculation_source).toBe('vacation_compensation')
    expect(byType.bonus.one_off_tax_percent).toBe(30)
    expect(byType.vacation).toMatchObject({ vacation_category: 'saved', vacation_saved_year: '2024' })
  })

  it('leaves the copied utlägg line without its claim link: the claim stays on the original line (unique index)', async () => {
    const { supabase, enqueueMany, findCalls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [ORIGINAL_EMPLOYEE] },
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
      { data: null },
    ])

    await correctSalaryRun(supabase as never, ARGS)

    const utlagg = copiedLines(findCalls).find((l) => l.item_type === 'expense_reimbursement')!
    expect(utlagg).toMatchObject({ amount: 640, account_number: '2820', source_expense_claim_id: null })
  })

  // Plan 1: the correction books on the default resolved at its own booking,
  // so a default the original run cached on its lines is not carried; a
  // deliberate override and the utlägg account are.
  it("drops the original's cached default accounts and keeps overrides", async () => {
    const { supabase, enqueueMany, findCalls } = trackedSupabase()
    const line = (id: string, item_type: string, account_number: string | null) => ({
      ...ORIGINAL_EMPLOYEE.line_items[1],
      id,
      item_type,
      account_number,
    })
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      {
        data: [
          {
            ...ORIGINAL_EMPLOYEE,
            employee: { employment_type: 'company_owner' },
            line_items: [
              line('li-hourly', 'hourly_salary', '7210'), // the bug: cached without the owner's type
              line('li-unpaid', 'unpaid_leave', '7220'), // cached with it
              line('li-bonus', 'bonus', '7010'), // a deliberate override
              { ...ORIGINAL_EMPLOYEE.line_items[3] }, // utlägg on its claim's 2820
            ],
          },
        ],
      },
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
      { data: null },
    ])

    await correctSalaryRun(supabase as never, ARGS)

    // The employees join is read for the rule, never written back.
    expect(findCalls('salary_run_employees', 'insert')[0][0]).toEqual([
      expect.not.objectContaining({ employee: expect.anything() }),
    ])
    const accounts = Object.fromEntries(copiedLines(findCalls).map((l) => [l.item_type as string, l.account_number]))
    expect(accounts).toEqual({
      hourly_salary: null,
      unpaid_leave: null,
      bonus: '7010',
      expense_reimbursement: '2820',
    })
  })

  it('copies the engine semesterersättning row as engine-owned, so recalculating replaces it instead of adding a second one', async () => {
    const { supabase, enqueueMany, findCalls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      { data: [ORIGINAL_EMPLOYEE] },
      { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
      { data: null },
    ])

    await correctSalaryRun(supabase as never, ARGS)

    const lines = copiedLines(findCalls)
    const copiedVacationPay = lines.find((l) => l.item_type === 'semesterersattning')!
    // run-calculation step 8h deletes the engine's row by this provenance and
    // derives it again; manual lines (fed to the engine as extra pay) are the
    // ones isCalculatedLine rejects. A copy without the provenance would be
    // both kept as manual pay and derived again: semesterersättning twice.
    expect(isAutomaticVacationLine(copiedVacationPay)).toBe(true)
    expect(lines.filter((l) => !isCalculatedLine(l)).map((l) => l.item_type)).toEqual([
      'bonus',
      'vacation',
      'expense_reimbursement',
    ])
  })

  it.each([
    [
      'the roster read',
      [{ data: null, error: { message: 'read failed' } }],
      { message: 'read failed' },
    ],
    [
      'the roster insert',
      [{ data: [ORIGINAL_EMPLOYEE] }, { data: null, error: { message: 'roster insert failed' } }],
      { message: 'roster insert failed' },
    ],
    [
      'the line insert',
      [
        { data: [ORIGINAL_EMPLOYEE] },
        { data: [{ id: 'sre-new', employee_id: 'emp-1' }] },
        { data: null, error: { message: 'line insert failed' } },
      ],
      { message: 'line insert failed' },
    ],
  ])('fails on an error in %s and removes the half-copied correction run so a retry resumes', async (_label, copyResults, expectedError) => {
    const { supabase, enqueueMany, findCalls, calls } = trackedSupabase()
    enqueueMany([
      { data: makeBookedRun() },
      { data: null },
      { data: CORRECTION_ROW },
      ...copyResults,
      { data: null }, // delete of the correction run
    ])

    const result = await correctSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'DB_ERROR', stage: 'copy_roster', error: expectedError })
    expect(findCalls('salary_runs', 'delete')).toHaveLength(1)
    const deleteIdx = calls.findIndex((c) => c.table === 'salary_runs' && c.method === 'delete')
    expect(calls.slice(deleteIdx + 1, deleteIdx + 3).map((c) => [c.method, ...c.args])).toEqual([
      ['eq', 'id', 'corr-1'],
      ['eq', 'company_id', 'company-1'],
    ])
    expect(syncVacationLedgerForEmployees).not.toHaveBeenCalled()
  })
})
