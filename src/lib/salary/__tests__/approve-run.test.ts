/**
 * The approval rules every door applies (validateRunForApproval) and the
 * review → approved step the dashboard route and the v1 verb share
 * (approveReviewedSalaryRun), lib/salary/approve-run.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/lib/salary/ytd', () => ({
  refreshRunYtd: vi.fn().mockResolvedValue({ ok: true, updated: 0 }),
}))

import { approveReviewedSalaryRun, validateRunForApproval, type ApprovalRosterRow } from '../approve-run'
import { eventBus } from '@/lib/events'
import { refreshRunYtd } from '@/lib/salary/ytd'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
const ARGS = { companyId: 'company-1', userId: 'user-1', salaryRunId: 'run-1', log }

function row(overrides: Partial<ApprovalRosterRow> = {}, employee: Partial<NonNullable<ApprovalRosterRow['employee']>> = {}): ApprovalRosterRow {
  return {
    employee_id: 'e1',
    calculation_breakdown: { steps: [] },
    net_salary: 23000,
    tax_withheld: 7000,
    tax_withheld_override: null,
    employee: {
      first_name: 'Anna',
      last_name: 'Svensson',
      clearing_number: '8327',
      bank_account_number: '123456789',
      email: 'anna@example.se',
      f_skatt_status: 'a_skatt',
      ...employee,
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('validateRunForApproval', () => {
  it('passes a calculated roster with payable bank details and email', () => {
    expect(validateRunForApproval([row()])).toEqual({
      uncalculated: [],
      blocking: [],
      bankDetails: [],
      warnings: [],
    })
  })

  it('blocks a roster row without a calculation, by name', () => {
    const verdict = validateRunForApproval([row({ calculation_breakdown: null })])
    expect(verdict.uncalculated).toEqual(['Anna Svensson'])
    expect(verdict.blocking).toEqual(['Anna Svensson: Beräkning saknas, kör beräkning först'])
  })

  it('names a row whose employee is gone by its employee id, and still blocks it', () => {
    const verdict = validateRunForApproval([row({ calculation_breakdown: null, employee: null })])
    expect(verdict.uncalculated).toEqual(['e1'])
  })

  it('asks for bank details only for an employee with a payout', () => {
    const verdict = validateRunForApproval([
      row({}, { clearing_number: null, bank_account_number: null }),
      row(
        { employee_id: 'e2', net_salary: 0, tax_withheld: 0 },
        { first_name: 'Nils', last_name: 'Noll', clearing_number: null, bank_account_number: null },
      ),
    ])
    expect(verdict.bankDetails).toHaveLength(1)
    expect(verdict.bankDetails[0]).toMatch(/^Anna Svensson:/)
    expect(verdict.blocking).toEqual([])
  })

  it('counts a tax override into the payout that needs an account', () => {
    // Net 0 as calculated, but 500 kr less tax withheld by override: 500 kr
    // goes to the bank, so an account is needed.
    const verdict = validateRunForApproval([
      row({ net_salary: 0, tax_withheld: 500, tax_withheld_override: 0 }, { clearing_number: null, bank_account_number: null }),
    ])
    expect(verdict.bankDetails).toHaveLength(1)
  })

  it('warns about F-skatt not verified and a missing email', () => {
    const verdict = validateRunForApproval([row({}, { f_skatt_status: 'not_verified', email: null })])
    expect(verdict.warnings).toEqual([
      'Anna Svensson: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)',
      'Anna Svensson: E-post saknas, lönebesked kan inte skickas',
    ])
    expect(verdict.blocking).toEqual([])
  })

  it('blocks a draft that was never calculated, even with an empty roster (the review step\'s rule)', () => {
    const verdict = validateRunForApproval([], { status: 'draft', calculation_params: null })
    expect(verdict.blocking).toEqual(['Lönekörningen är inte beräknad: beräkna den först.'])
  })

  it('leaves a run past draft to the row rule', () => {
    expect(validateRunForApproval([], { status: 'review', calculation_params: null }).blocking).toEqual([])
  })
})

describe('approveReviewedSalaryRun', () => {
  it('answers SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = await approveReviewedSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('answers SALARY_RUN_APPROVE_NOT_REVIEW with the current status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft' } })

    const result = await approveReviewedSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_APPROVE_NOT_REVIEW',
      details: { current_status: 'draft' },
    })
  })

  it('refuses a blocking problem even when forced, and writes nothing', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'review' } }, { data: [row({ calculation_breakdown: null })] }])

    const result = await approveReviewedSalaryRun(supabase as never, ARGS, { force: true })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('SALARY_APPROVE_BLOCKED')
      expect(result.verdict?.blocking).toEqual(['Anna Svensson: Beräkning saknas, kör beräkning först'])
    }
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('refuses missing bank details unless forced', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'review' } },
      { data: [row({}, { clearing_number: null, bank_account_number: null })] },
    ])

    const result = await approveReviewedSalaryRun(supabase as never, ARGS)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SALARY_APPROVE_BANK_DETAILS_MISSING')
    expect(findCall('salary_runs', 'update')).toBeUndefined()
  })

  it('approves when forced past bank details, keeping them on the warnings', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'review' } },
      { data: [row({}, { clearing_number: null, bank_account_number: null, email: null })] },
      { data: { id: 'run-1', status: 'approved' } },
    ])

    const result = await approveReviewedSalaryRun(supabase as never, ARGS, { force: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.run).toEqual({ id: 'run-1', status: 'approved' })
      expect(result.data.warnings[0]).toMatch(/^Anna Svensson:/)
      expect(result.data.warnings).toContain('Anna Svensson: E-post saknas, lönebesked kan inte skickas')
    }
    expect(findCall('salary_runs', 'update')).toEqual([
      expect.objectContaining({ status: 'approved', approved_by: 'user-1' }),
    ])
    expect(refreshRunYtd).toHaveBeenCalledWith(supabase, { companyId: 'company-1', salaryRunId: 'run-1' })
    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'salary_run.approved',
      payload: { salaryRunId: 'run-1', approvedBy: 'user-1', userId: 'user-1', companyId: 'company-1' },
    })
  })

  it('validates without writing on a dry run', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'run-1', status: 'review' } }, { data: [row()] }])

    const result = await approveReviewedSalaryRun(supabase as never, ARGS, { dryRun: true })

    expect(result).toEqual({
      ok: true,
      data: { run: null, warnings: [], verdict: { uncalculated: [], blocking: [], bankDetails: [], warnings: [] } },
    })
    expect(findCall('salary_runs', 'update')).toBeUndefined()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('answers NOT_REVIEW when a concurrent approval won the optimistic lock, and emits nothing', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'run-1', status: 'review' } },
      { data: [row()] },
      { data: null }, // the status-locked update matched no row
    ])

    const result = await approveReviewedSalaryRun(supabase as never, ARGS)

    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_APPROVE_NOT_REVIEW', details: { reason: 'race' } })
    expect(findCalls('salary_runs', 'eq')).toContainEqual(['status', 'review'])
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
