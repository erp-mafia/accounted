/**
 * Utlägg on the payslip (#2331): lib/salary/expense-claim-lines.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  addOpenExpenseClaimsToPayslip,
  assertLinkedExpenseClaimsOpen,
  findPayslipLineForClaim,
  listOpenExpenseClaimsForEmployee,
  rosterHasLinkedExpenseClaims,
  settleExpenseClaimsForBookedRun,
} from '../expense-claim-lines'

const COMPANY = 'company-1'
const RUN = 'run-1'
const EMPLOYEE = 'emp-1'

const { supabase, enqueue, enqueueMany, reset, findCall, findCalls } = createQueuedMockSupabase()
const sb = supabase as never

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('listOpenExpenseClaimsForEmployee', () => {
  it('returns the registered claims that are not yet on a payslip line, amounts as numbers', async () => {
    enqueueMany([
      {
        data: [
          { id: 'c-a', description: 'Kabel', expense_date: '2026-06-01', amount_sek: '250.50', liability_account: '2820' },
          { id: 'c-b', description: 'Tåg', expense_date: '2026-06-03', amount_sek: 1196, liability_account: '2820' },
        ],
      },
      { data: [{ source_expense_claim_id: 'c-a' }] }, // c-a already scheduled on another draft
    ])

    const open = await listOpenExpenseClaimsForEmployee(sb, COMPANY, EMPLOYEE)

    expect(open).toEqual([
      { id: 'c-b', description: 'Tåg', expense_date: '2026-06-03', amount_sek: 1196, liability_account: '2820' },
    ])
    expect(findCall('salary_line_items', 'in')).toEqual(['source_expense_claim_id', ['c-a', 'c-b']])
  })

  it('does not look for scheduled lines when the employee has no registered claims', async () => {
    enqueue({ data: [] })
    expect(await listOpenExpenseClaimsForEmployee(sb, COMPANY, EMPLOYEE)).toEqual([])
    expect(findCalls('salary_line_items', 'select')).toEqual([])
  })
})

describe('addOpenExpenseClaimsToPayslip', () => {
  it('refuses once the run has left draft (same gate as the other line commands)', async () => {
    enqueue({ data: { id: RUN, status: 'review' } })
    const result = await addOpenExpenseClaimsToPayslip(sb, { companyId: COMPANY, salaryRunId: RUN, employeeId: EMPLOYEE })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_LINE_NOT_DRAFT' })
    expect(findCalls('salary_line_items', 'insert')).toEqual([])
  })

  it('refuses an employee who is not on the run', async () => {
    enqueueMany([{ data: { id: RUN, status: 'draft' } }, { data: null }])
    const result = await addOpenExpenseClaimsToPayslip(sb, { companyId: COMPANY, salaryRunId: RUN, employeeId: EMPLOYEE })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' })
  })

  it('answers SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS when nothing is left to add', async () => {
    enqueueMany([
      { data: { id: RUN, status: 'draft' } },
      { data: { id: 'sre-1', employee_id: EMPLOYEE } },
      { data: [] }, // no registered claims
    ])
    const result = await addOpenExpenseClaimsToPayslip(sb, { companyId: COMPANY, salaryRunId: RUN, employeeId: EMPLOYEE })
    expect(result).toMatchObject({ ok: false, code: 'SALARY_RUN_NO_OPEN_EXPENSE_CLAIMS' })
  })

  it('inserts one tax-free expense_reimbursement line per claim, linked, with the claim account and amount', async () => {
    enqueueMany([
      { data: { id: RUN, status: 'draft' } },
      { data: { id: 'sre-1', employee_id: EMPLOYEE } },
      {
        data: [
          { id: 'c-a', description: 'Kabel', expense_date: '2026-06-01', amount_sek: '250.50', liability_account: '2820' },
          { id: 'c-b', description: 'Tåg', expense_date: '2026-06-03', amount_sek: 1196, liability_account: '2820' },
        ],
      },
      { data: [] }, // nothing scheduled elsewhere
      { data: [{ id: 'li-1', source_expense_claim_id: 'c-a' }, { id: 'li-2', source_expense_claim_id: 'c-b' }] },
    ])

    const result = await addOpenExpenseClaimsToPayslip(sb, { companyId: COMPANY, salaryRunId: RUN, employeeId: EMPLOYEE })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.claim_count).toBe(2)
      expect(result.data.total_sek).toBe(1446.5)
      expect(result.data.lines).toHaveLength(2)
    }
    const [rows] = findCall('salary_line_items', 'insert') as [Array<Record<string, unknown>>]
    expect(rows).toEqual([
      expect.objectContaining({
        salary_run_employee_id: 'sre-1',
        company_id: COMPANY,
        item_type: 'expense_reimbursement',
        description: 'Utlägg: Kabel (2026-06-01)',
        amount: 250.5,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: '2820',
        sort_order: 500,
        source_expense_claim_id: 'c-a',
      }),
      expect.objectContaining({ amount: 1196, sort_order: 501, source_expense_claim_id: 'c-b' }),
    ])
  })

  it('maps the partial unique index violation to EXPENSE_CLAIM_ALREADY_ON_PAYSLIP', async () => {
    enqueueMany([
      { data: { id: RUN, status: 'draft' } },
      { data: { id: 'sre-1', employee_id: EMPLOYEE } },
      { data: [{ id: 'c-a', description: 'Kabel', expense_date: '2026-06-01', amount_sek: 100, liability_account: '2820' }] },
      { data: [] },
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ])
    const result = await addOpenExpenseClaimsToPayslip(sb, { companyId: COMPANY, salaryRunId: RUN, employeeId: EMPLOYEE })
    expect(result).toMatchObject({ ok: false, code: 'EXPENSE_CLAIM_ALREADY_ON_PAYSLIP' })
  })
})

describe('findPayslipLineForClaim', () => {
  it('returns null when the claim is on no payslip', async () => {
    enqueue({ data: null })
    expect(await findPayslipLineForClaim(sb, COMPANY, 'c-a')).toBeNull()
  })

  it('flattens the line -> run employee -> run embed', async () => {
    enqueue({
      data: {
        id: 'li-1',
        salary_run_employee: {
          salary_run_id: RUN,
          salary_run: { id: RUN, status: 'review', period_year: 2026, period_month: 6 },
        },
      },
    })
    expect(await findPayslipLineForClaim(sb, COMPANY, 'c-a')).toEqual({
      line_id: 'li-1',
      salary_run_id: RUN,
      run_status: 'review',
      period_year: 2026,
      period_month: 6,
    })
    expect(findCall('salary_line_items', 'eq')).toEqual(['company_id', COMPANY])
  })
})

describe('assertLinkedExpenseClaimsOpen', () => {
  const roster = (lines: Array<Record<string, unknown>>) => [{ employee_id: EMPLOYEE, line_items: lines }]

  it('is a no-op without linked lines: no query at all', async () => {
    const result = await assertLinkedExpenseClaimsOpen(sb, COMPANY, roster([{ item_type: 'monthly_salary', amount: 30000 }]))
    expect(result).toEqual({ ok: true, claim_count: 0 })
    expect(findCalls('expense_claims', 'select')).toEqual([])
    expect(rosterHasLinkedExpenseClaims(roster([{ item_type: 'monthly_salary' }]))).toBe(false)
  })

  it('passes when every linked claim is registered for the right employee at the line amount', async () => {
    enqueue({ data: [{ id: 'c-a', status: 'registered', employee_id: EMPLOYEE, amount_sek: '250.50' }] })
    const result = await assertLinkedExpenseClaimsOpen(
      sb,
      COMPANY,
      roster([{ item_type: 'expense_reimbursement', amount: 250.5, source_expense_claim_id: 'c-a' }]),
    )
    expect(result).toEqual({ ok: true, claim_count: 1 })
    expect(rosterHasLinkedExpenseClaims(roster([{ source_expense_claim_id: 'c-a' }]))).toBe(true)
  })

  it('names every problem: paid, missing, wrong employee, drifted amount', async () => {
    enqueue({
      data: [
        { id: 'c-paid', status: 'paid', employee_id: EMPLOYEE, amount_sek: 100 },
        { id: 'c-other', status: 'registered', employee_id: 'emp-2', amount_sek: 100 },
        { id: 'c-drift', status: 'registered', employee_id: EMPLOYEE, amount_sek: 99 },
      ],
    })
    const result = await assertLinkedExpenseClaimsOpen(
      sb,
      COMPANY,
      roster([
        { amount: 100, source_expense_claim_id: 'c-paid' },
        { amount: 100, source_expense_claim_id: 'c-gone' },
        { amount: 100, source_expense_claim_id: 'c-other' },
        { amount: 100, source_expense_claim_id: 'c-drift' },
      ]),
    )
    expect(result).toEqual({
      ok: false,
      code: 'SALARY_RUN_EXPENSE_CLAIM_NOT_OPEN',
      details: {
        claims: [
          { claim_id: 'c-paid', reason: 'not_open' },
          { claim_id: 'c-gone', reason: 'missing' },
          { claim_id: 'c-other', reason: 'employee_mismatch' },
          { claim_id: 'c-drift', reason: 'amount_mismatch' },
        ],
      },
    })
  })
})

describe('settleExpenseClaimsForBookedRun', () => {
  const args = { companyId: COMPANY, userId: 'user-1', salaryRunId: RUN }

  it('calls the RPC with the run and maps the batches', async () => {
    enqueue({
      data: {
        ok: true,
        claim_count: 2,
        already_settled: 0,
        total_sek: '1446.50',
        batches: [{ batch_id: 'b-1', employee_id: EMPLOYEE, total_sek: '1446.50', claim_count: 2 }],
      },
    })
    const result = await settleExpenseClaimsForBookedRun(sb, args)
    expect(result).toEqual({
      ok: true,
      data: {
        claim_count: 2,
        already_settled: 0,
        total_sek: 1446.5,
        batches: [{ batch_id: 'b-1', employee_id: EMPLOYEE, total_sek: 1446.5, claim_count: 2 }],
      },
    })
    expect(supabase.rpc).toHaveBeenCalledWith('settle_expense_claims_via_salary_run', {
      p_company_id: COMPANY,
      p_salary_run_id: RUN,
      p_user_id: 'user-1',
    })
  })

  it('echoes an RPC refusal code with its details', async () => {
    enqueue({ data: { ok: false, code: 'CLAIM_NOT_OPEN', details: { claim_id: 'c-a' } } })
    expect(await settleExpenseClaimsForBookedRun(sb, args)).toEqual({
      ok: false,
      code: 'CLAIM_NOT_OPEN',
      detail: '{"claim_id":"c-a"}',
    })
  })

  it('reports a database error as SETTLE_FAILED with the message', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    expect(await settleExpenseClaimsForBookedRun(sb, args)).toEqual({
      ok: false,
      code: 'SETTLE_FAILED',
      detail: 'connection reset',
    })
  })
})
