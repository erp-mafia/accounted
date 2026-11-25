/**
 * A payslip row of semesterlön for rörliga lönedelar paid with the salary
 * under a central kollektivavtal (Semesterlagen 2 a § andra stycket,
 * lib/salary/variable-vacation-pay.ts): the line command every door runs
 * accepts the mark only on a positive semesterersättning row of an employee
 * on sammalöneregeln, records the confirmation in audit_log, and keeps the
 * row semesterersättning on an edit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { CreateSalaryLineItemSchema, UpdateSalaryLineItemSchema } from '@/lib/api/schemas'

const serviceFrom = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: serviceFrom }),
}))

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

import {
  VARIABLE_VACATION_PAY_WITH_SALARY_AMOUNT_MESSAGE,
  VARIABLE_VACATION_PAY_WITH_SALARY_RETYPE_MESSAGE,
  VARIABLE_VACATION_PAY_WITH_SALARY_RULE_MESSAGE,
  VARIABLE_VACATION_PAY_WITH_SALARY_TYPE_MESSAGE,
  createPayslipLine,
  updatePayslipLine,
} from '@/lib/salary/payslip-lines'
import { VARIABLE_VACATION_PAY_WITH_SALARY_GUARD } from '@/lib/salary/sammaloneregeln-kollektivavtal-record'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

const PAID_WITH_SALARY = {
  item_type: 'semesterersattning' as const,
  description: 'Semesterlön rörliga lönedelar',
  amount: 600,
  sort_order: 0,
  settles_variable_vacation_pay: true,
}

const STORED_LINE = {
  id: LINE_ID,
  salary_run_employee_id: SRE_ID,
  company_id: COMPANY_ID,
  item_type: 'semesterersattning',
  description: 'Semesterlön rörliga lönedelar',
  quantity: null,
  unit_price: null,
  amount: 600,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
  account_number: null,
  sort_order: 0,
  created_at: '2026-11-25T08:00:00Z',
  updated_at: '2026-11-25T08:00:00Z',
}

let mock: ReturnType<typeof createQueuedMockSupabase>
let supabase: SupabaseClient
let auditInsert: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createQueuedMockSupabase()
  supabase = mock.supabase as unknown as SupabaseClient
  auditInsert = vi.fn(async () => ({ error: null }))
  serviceFrom.mockReturnValue({ insert: auditInsert })
})

function create(input: Record<string, unknown>, dryRun = false) {
  return runWithActor({ type: 'user', userId: USER_ID }, () =>
    createPayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { salaryRunEmployeeId: SRE_ID },
      input: CreateSalaryLineItemSchema.omit({ salary_run_employee_id: true }).parse(input),
      dryRun,
    }),
  )
}

/** The run is a draft and the employee is on it. */
function enqueueGate() {
  mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
  mock.enqueue({ data: { id: SRE_ID, employee_id: EMPLOYEE_ID } })
}

describe('createPayslipLine: semesterlön for rörliga lönedelar paid with the salary', () => {
  it('stores the mark on a semesterersättning row of a sammalöneregeln employee and records the confirmation', async () => {
    enqueueGate()
    mock.enqueue({ data: { employee: { vacation_rule: 'sammaloneregeln' } } })
    mock.enqueue({ data: STORED_LINE })

    const result = await create(PAID_WITH_SALARY)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toMatchObject({ id: LINE_ID, settles_variable_vacation_pay: true })
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).toMatchObject({
      item_type: 'semesterersattning',
      amount: 600,
      is_vacation_basis: false,
      settles_variable_vacation_pay: true,
    })
    expect(serviceFrom).toHaveBeenCalledWith('audit_log')
    expect(auditInsert).toHaveBeenCalledTimes(1)
    const record = auditInsert.mock.calls[0][0]
    expect(record).toMatchObject({
      user_id: USER_ID,
      company_id: COMPANY_ID,
      action: 'GUARD_BYPASSED',
      table_name: 'salary_line_items',
      record_id: LINE_ID,
      actor_type: 'user',
      new_state: {
        guard: VARIABLE_VACATION_PAY_WITH_SALARY_GUARD,
        reason: 'kollektivavtal',
        employee_id: EMPLOYEE_ID,
        salary_run_id: RUN_ID,
        salary_line_item_id: LINE_ID,
      },
    })
    // Ids only: never the amount.
    expect(JSON.stringify(record)).not.toContain('600')
  })

  it('keeps the line when the audit row cannot be written', async () => {
    enqueueGate()
    mock.enqueue({ data: { employee: { vacation_rule: 'sammaloneregeln' } } })
    mock.enqueue({ data: STORED_LINE })
    auditInsert.mockResolvedValueOnce({ error: { message: 'boom', code: 'XX000' } })

    const result = await create(PAID_WITH_SALARY)
    expect(result.ok).toBe(true)
  })

  it('a dry run judges the row and records nothing', async () => {
    enqueueGate()
    mock.enqueue({ data: { employee: { vacation_rule: 'sammaloneregeln' } } })

    const result = await create(PAID_WITH_SALARY, true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toMatchObject({ id: null, settles_variable_vacation_pay: true })
    expect(mock.findCall('salary_line_items', 'insert')).toBeUndefined()
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('refuses the mark on any other type', async () => {
    enqueueGate()
    const result = await create({ ...PAID_WITH_SALARY, item_type: 'bonus' })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'settles_variable_vacation_pay', message: VARIABLE_VACATION_PAY_WITH_SALARY_TYPE_MESSAGE },
    })
    expect(mock.findCall('salary_line_items', 'insert')).toBeUndefined()
  })

  it('refuses an amount that is not above zero', async () => {
    enqueueGate()
    const result = await create({ ...PAID_WITH_SALARY, amount: -600 })
    expect(result).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'amount', message: VARIABLE_VACATION_PAY_WITH_SALARY_AMOUNT_MESSAGE },
    })
  })

  it('refuses an employee who is not on sammalöneregeln', async () => {
    for (const rule of ['procentregeln', 'semesterersattning', 'none']) {
      mock = createQueuedMockSupabase()
      supabase = mock.supabase as unknown as SupabaseClient
      enqueueGate()
      mock.enqueue({ data: { employee: { vacation_rule: rule } } })
      const result = await create(PAID_WITH_SALARY)
      expect(result, rule).toEqual({
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'settles_variable_vacation_pay', message: VARIABLE_VACATION_PAY_WITH_SALARY_RULE_MESSAGE },
      })
      expect(mock.findCall('salary_line_items', 'insert')).toBeUndefined()
    }
    expect(auditInsert).not.toHaveBeenCalled()
  })

  it('a semesterersättning row without the mark is written as before, without the column', async () => {
    enqueueGate()
    mock.enqueue({ data: STORED_LINE })
    const result = await create({ ...PAID_WITH_SALARY, settles_variable_vacation_pay: undefined })
    expect(result.ok).toBe(true)
    expect(mock.findCall('salary_line_items', 'insert')?.[0]).not.toHaveProperty('settles_variable_vacation_pay')
    expect(auditInsert).not.toHaveBeenCalled()
  })
})

describe('updatePayslipLine: a row paid with the salary', () => {
  it('the mark is not an edit: the update schema drops it', () => {
    expect(UpdateSalaryLineItemSchema.parse({ settles_variable_vacation_pay: true })).not.toHaveProperty('settles_variable_vacation_pay')
  })

  it('refuses to retype a marked row, and lets an unmarked one change type', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...STORED_LINE, salary_run_employee: { salary_run_id: RUN_ID } } })
    mock.enqueue({ data: { ...STORED_LINE, settles_variable_vacation_pay: true } })
    const refused = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { item_type: 'bonus' },
    })
    expect(refused).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'item_type', message: VARIABLE_VACATION_PAY_WITH_SALARY_RETYPE_MESSAGE },
    })
    expect(mock.findCall('salary_line_items', 'update')).toBeUndefined()

    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...STORED_LINE, salary_run_employee: { salary_run_id: RUN_ID } } })
    // Before the migration the column is absent: the row is unmarked.
    mock.enqueue({ data: STORED_LINE })
    mock.enqueue({ data: { ...STORED_LINE, item_type: 'bonus' } })
    const retyped = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { item_type: 'bonus' },
    })
    expect(retyped.ok).toBe(true)
  })

  it('an amount edit of a marked row does not read the mark', async () => {
    mock.enqueue({ data: { id: RUN_ID, status: 'draft' } })
    mock.enqueue({ data: { ...STORED_LINE, salary_run_employee: { salary_run_id: RUN_ID } } })
    mock.enqueue({ data: { ...STORED_LINE, amount: 720 } })
    const result = await updatePayslipLine(supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      patch: { amount: 720 },
    })
    expect(result.ok).toBe(true)
    const fromCalls = (mock.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['salary_runs', 'salary_line_items', 'salary_line_items'])
  })
})
