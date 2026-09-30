/**
 * The salary-run structure operations (../salary-run-structure.ts): MCP-only
 * doors onto the services the hand-written v1 routes call. The services are
 * mocked (their rules are tested in lib/salary/__tests__); what is pinned
 * here is each operation's contract: the input it accepts, that a dry run is
 * the service's own dry run, that a result becomes the qualified-id output,
 * and that a refusal reaches the agent with the service's code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const services = vi.hoisted(() => ({
  listSalaryRuns: vi.fn(),
  addEmployeeToRun: vi.fn(),
  removeEmployeeFromRun: vi.fn(),
  createPayslipLine: vi.fn(),
  deletePayslipLine: vi.fn(),
  correctSalaryRun: vi.fn(),
  markSalaryRunPaid: vi.fn(),
}))

vi.mock('@/lib/salary/list-runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/list-runs')>()),
  listSalaryRuns: services.listSalaryRuns,
}))
vi.mock('@/lib/salary/run-employees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/run-employees')>()),
  addEmployeeToRun: services.addEmployeeToRun,
  removeEmployeeFromRun: services.removeEmployeeFromRun,
}))
vi.mock('@/lib/salary/payslip-lines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslip-lines')>()),
  createPayslipLine: services.createPayslipLine,
  deletePayslipLine: services.deletePayslipLine,
}))
vi.mock('@/lib/salary/correct-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/correct-run')>()),
  correctSalaryRun: services.correctSalaryRun,
}))
vi.mock('@/lib/salary/mark-paid', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/mark-paid')>()),
  markSalaryRunPaid: services.markSalaryRunPaid,
}))

import { AddEmployeeToRunSchema, CreateSalaryLineItemSchema } from '@/lib/api/schemas'
import { listEndpoints } from '@/lib/api/v1/registry'
import { SalaryRunStatusSchema } from '@/lib/salary/list-runs'
import { PartialCommitError } from '@/lib/pending-operations/errors'
import type { Logger } from '@/lib/logger'
import type { AnyOperation, OperationContext } from '../types'
import {
  salaryRunsCorrect,
  salaryRunsEmployeesAdd,
  salaryRunsEmployeesRemove,
  salaryRunsLinesCreate,
  salaryRunsLinesDelete,
  salaryRunsList,
  salaryRunsMarkPaid,
} from '../salary-run-structure'
// The v1 doors of the same capabilities: registering them lets the contract
// test compare ids, scopes and risks with what the operations declare.
import '@/app/api/v1/companies/[companyId]/salary-runs/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/[employeeId]/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/employees/[employeeId]/lines/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/lines/[lineId]/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/correct/route'
import '@/app/api/v1/companies/[companyId]/salary-runs/[id]/mark-paid/route'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'user-1'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CORRECTION_RUN_ID = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'
const EMP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SRE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE_ID = '88888888-8888-4888-8888-888888888888'
const ENTRY_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]

const OPERATIONS: AnyOperation[] = [
  salaryRunsList,
  salaryRunsEmployeesAdd,
  salaryRunsEmployeesRemove,
  salaryRunsLinesCreate,
  salaryRunsLinesDelete,
  salaryRunsCorrect,
  salaryRunsMarkPaid,
]

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger
const ctx: OperationContext = { supabase: {} as never, companyId: COMPANY_ID, userId: USER_ID, log }

const accepts = (op: AnyOperation, input: unknown) => op.input.safeParse(input).success

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('contract', () => {
  const v1 = new Map(listEndpoints().map((endpoint) => [endpoint.operation, endpoint]))

  it('reuses the v1 operation id and scope of the hand-written route it mirrors, never at a lower risk', () => {
    // The MCP approval tier may be stricter than the v1 label: a staged write
    // that changes a pay outcome is reviewed at medium (risk-tiers.ts), as the
    // hand-written update_payslip_line and set_run_salary already are.
    const rank = { low: 0, medium: 1, high: 2 } as const
    for (const op of OPERATIONS) {
      const endpoint = v1.get(op.id)
      expect(endpoint, `${op.id}: no v1 route registers this operation id`).toBeDefined()
      expect(op.scope, op.id).toBe(endpoint!.scope)
      expect(rank[op.risk], op.id).toBeGreaterThanOrEqual(rank[endpoint!.risk as keyof typeof rank])
      expect(op.http, `${op.id}: MCP only, the v1 door is the hand-written route`).toBeUndefined()
    }
  })

  it('binds every operation to a distinct MCP tool, search-only, within the description budget', () => {
    const names = OPERATIONS.map((op) => op.mcp!.name)
    expect(names).toEqual([
      'gnubok_list_salary_runs',
      'gnubok_add_salary_run_employee',
      'gnubok_remove_salary_run_employee',
      'gnubok_add_payslip_line',
      'gnubok_delete_payslip_line',
      'gnubok_correct_salary_run',
      'gnubok_mark_salary_run_paid',
    ])
    for (const op of OPERATIONS) {
      const mcp = op.mcp!
      expect(mcp.visibility, op.id).toBeUndefined()
      expect(mcp.description!.length, op.id).toBeLessThanOrEqual(280)
      expect(mcp.keywords!.length, op.id).toBeGreaterThan(0)
      for (const keyword of mcp.keywords!) expect(keyword, op.id).toBe(keyword.toLowerCase())
      expect(op.input instanceof z.ZodObject, op.id).toBe(true)
      // The MCP door generates the tool's inputSchema from the Zod input.
      expect(() => z.toJSONSchema(op.input as z.ZodTypeAny, { io: 'input', unrepresentable: 'any' })).not.toThrow()
    }
  })

  it('stages every write under its own pending type with a one-line Swedish title', () => {
    const writes = OPERATIONS.filter((op) => op.kind === 'write')
    expect(writes.map((op) => op.mcp!.stage!.pendingType)).toEqual([
      'add_salary_run_employee',
      'remove_salary_run_employee',
      'add_payslip_line',
      'delete_payslip_line',
      'correct_salary_run',
      'mark_salary_run_paid',
    ])
    for (const op of writes) {
      expect(op.mcp!.description, op.id).toMatch(/\bStage\b/)
      const title = op.mcp!.stage!.title({ salary_run_id: RUN_ID, description: 'Bonus', amount: 1000 })
      expect(title.length, op.id).toBeGreaterThan(0)
      expect(title, op.id).not.toContain('\n')
    }
    expect(salaryRunsList.mcp!.stage).toBeUndefined()
  })

  it('names every identifier in the outputs, never a bare id', () => {
    const bareIds: string[] = []
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return
      const schema = node as { properties?: Record<string, unknown>; items?: unknown }
      if (schema.properties) {
        if ('id' in schema.properties) bareIds.push(path)
        for (const [key, child] of Object.entries(schema.properties)) walk(child, `${path}.${key}`)
      }
      if (schema.items) walk(schema.items, `${path}[]`)
    }
    for (const op of OPERATIONS) walk(z.toJSONSchema(op.output as z.ZodTypeAny, { unrepresentable: 'any' }), op.id)
    expect(bareIds).toEqual([])
  })

  it('describes its inputs without touching the shared v1 schemas it reuses', () => {
    // .describe() clones: the v1 bodies (and so openapi.json) stay as they were.
    expect(CreateSalaryLineItemSchema.shape.item_type.description).toBeUndefined()
    expect(CreateSalaryLineItemSchema.shape.amount.description).toBeUndefined()
    expect(AddEmployeeToRunSchema.shape.hours_worked.description).toBeUndefined()
    expect(SalaryRunStatusSchema.description).toBeUndefined()
    const lineInput = (salaryRunsLinesCreate.input as unknown as z.ZodObject<z.ZodRawShape>).shape
    expect((lineInput.item_type as z.ZodType).description).toMatch(/bonus/)
  })

  it('writes no em or en dash into anything an agent or approver reads', () => {
    for (const op of OPERATIONS) {
      const text = JSON.stringify({ docs: op.docs, mcp: op.mcp, input: z.toJSONSchema(op.input as z.ZodTypeAny, { io: 'input', unrepresentable: 'any' }) })
      expect(text, op.id).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

// ---------------------------------------------------------------------------
// salary-runs.list
// ---------------------------------------------------------------------------

const RUN_ROW = {
  id: RUN_ID,
  period_year: 2026,
  period_month: 9,
  payment_date: '2026-09-25',
  deviation_period_start: '2026-09-01',
  deviation_period_end: '2026-09-30',
  status: 'draft',
  voucher_series: 'L',
  total_gross: 0,
  total_tax: 0,
  total_net: 0,
  total_avgifter: 0,
  total_employer_cost: 0,
  agi_generated_at: null,
  agi_submitted_at: null,
  approved_at: null,
  paid_at: null,
  booked_at: null,
  created_at: '2026-09-01T08:00:00Z',
}

describe('salary-runs.list', () => {
  it('accepts the filters and pagination, coercing numbers, and refuses what v1 refuses', () => {
    expect(accepts(salaryRunsList, {})).toBe(true)
    expect(salaryRunsList.input.parse({ period_year: '2026', period_month: '9', limit: '10' })).toEqual({
      period_year: 2026,
      period_month: 9,
      limit: 10,
    })
    expect(accepts(salaryRunsList, { status: 'corrected', cursor: 'abc' })).toBe(true)
    expect(accepts(salaryRunsList, { period_year: 1999 })).toBe(false)
    expect(accepts(salaryRunsList, { period_month: 13 })).toBe(false)
    expect(accepts(salaryRunsList, { status: 'cancelled' })).toBe(false)
    expect(accepts(salaryRunsList, { limit: 101 })).toBe(false)
  })

  it('passes the filters to the shared list and renames id to salary_run_id', async () => {
    services.listSalaryRuns.mockResolvedValue({ ok: true, data: { runs: [RUN_ROW], next_cursor: 'next' } })
    const input = salaryRunsList.input.parse({ period_year: 2026, period_month: 9, status: 'draft', limit: 5, cursor: 'c1' })

    const outcome = await salaryRunsList.run(ctx, input, { dryRun: false })

    expect(services.listSalaryRuns).toHaveBeenCalledWith(ctx, {
      periodYear: 2026,
      periodMonth: 9,
      status: 'draft',
      cursor: 'c1',
      limit: 5,
    })
    expect(outcome.ok && !outcome.dryRun).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    const { id: _id, ...rest } = RUN_ROW
    expect(outcome.data).toEqual({ salary_runs: [{ salary_run_id: RUN_ID, ...rest }], next_cursor: 'next' })
    expect(salaryRunsList.output.parse(outcome.data)).toEqual(outcome.data)
  })

  it('passes a database failure through untouched', async () => {
    const failure = { ok: false, code: 'UNKNOWN_ERROR', error: { code: '57014' } }
    services.listSalaryRuns.mockResolvedValue(failure)
    expect(await salaryRunsList.run(ctx, {}, { dryRun: false })).toEqual(failure)
  })
})

// ---------------------------------------------------------------------------
// salary-runs.employees.add
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  salary_run_id: RUN_ID,
  employee_id: EMP_ID,
  company_id: COMPANY_ID,
  employment_degree: 80,
  monthly_salary: 35000,
  salary_type: 'monthly',
  hours_worked: null,
  tax_table_number: 33,
  tax_column: 1,
}

describe('salary-runs.employees.add', () => {
  it('takes the run and the employee, with hours for an hourly employee', () => {
    expect(accepts(salaryRunsEmployeesAdd, { salary_run_id: RUN_ID, employee_id: EMP_ID })).toBe(true)
    expect(accepts(salaryRunsEmployeesAdd, { salary_run_id: RUN_ID, employee_id: EMP_ID, hours_worked: 120.5 })).toBe(true)
    expect(accepts(salaryRunsEmployeesAdd, { salary_run_id: RUN_ID })).toBe(false)
    expect(accepts(salaryRunsEmployeesAdd, { salary_run_id: 'run-1', employee_id: EMP_ID })).toBe(false)
    expect(accepts(salaryRunsEmployeesAdd, { salary_run_id: RUN_ID, employee_id: EMP_ID, hours_worked: -1 })).toBe(false)
  })

  it('previews the snapshot from the service dry run', async () => {
    services.addEmployeeToRun.mockResolvedValue({ ok: true, data: { ...SNAPSHOT, id: null } })

    const outcome = await salaryRunsEmployeesAdd.run(ctx, { salary_run_id: RUN_ID, employee_id: EMP_ID }, { dryRun: true })

    expect(services.addEmployeeToRun).toHaveBeenCalledWith(ctx.supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMP_ID,
      hoursWorked: null,
      dryRun: true,
    })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { salary_run_id: RUN_ID, employee_id: EMP_ID, monthly_salary: 35000, employment_degree: 80 },
    })
    expect(outcome.ok && outcome.dryRun && 'salary_run_employee_id' in outcome.preview).toBe(false)
  })

  it('answers the attached roster row as a created resource', async () => {
    services.addEmployeeToRun.mockResolvedValue({
      ok: true,
      data: { ...SNAPSHOT, id: SRE_ID, hours_worked: 100, created_at: 'x', updated_at: 'x' },
    })

    const outcome = await salaryRunsEmployeesAdd.run(
      ctx,
      { salary_run_id: RUN_ID, employee_id: EMP_ID, hours_worked: 100 },
      { dryRun: false },
    )

    expect(services.addEmployeeToRun).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ hoursWorked: 100, dryRun: false }))
    expect(outcome).toMatchObject({ ok: true, created: true })
    if (!outcome.ok || outcome.dryRun) return
    expect(salaryRunsEmployeesAdd.output.parse(outcome.data)).toEqual({
      salary_run_employee_id: SRE_ID,
      salary_run_id: RUN_ID,
      employee_id: EMP_ID,
      salary_type: 'monthly',
      employment_degree: 80,
      monthly_salary: 35000,
      hours_worked: 100,
      tax_table_number: 33,
      tax_column: 1,
    })
  })

  it('passes a refusal through with its code and details', async () => {
    services.addEmployeeToRun.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_DUPLICATE',
      details: { salary_run_employee_id: SRE_ID },
    })
    expect(await salaryRunsEmployeesAdd.run(ctx, { salary_run_id: RUN_ID, employee_id: EMP_ID }, { dryRun: true })).toEqual({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_DUPLICATE',
      details: { salary_run_employee_id: SRE_ID },
    })
  })
})

// ---------------------------------------------------------------------------
// salary-runs.employees.remove
// ---------------------------------------------------------------------------

describe('salary-runs.employees.remove', () => {
  it('takes the run and the employee id', () => {
    expect(accepts(salaryRunsEmployeesRemove, { salary_run_id: RUN_ID, employee_id: EMP_ID })).toBe(true)
    expect(accepts(salaryRunsEmployeesRemove, { salary_run_id: RUN_ID, employee_id: 'anna' })).toBe(false)
    expect(accepts(salaryRunsEmployeesRemove, { employee_id: EMP_ID })).toBe(false)
  })

  it('previews the removal from the service dry run', async () => {
    services.removeEmployeeFromRun.mockResolvedValue({ ok: true, data: { deleted: true, employee_id: EMP_ID } })

    const outcome = await salaryRunsEmployeesRemove.run(ctx, { salary_run_id: RUN_ID, employee_id: EMP_ID }, { dryRun: true })

    expect(services.removeEmployeeFromRun).toHaveBeenCalledWith(ctx.supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      employeeId: EMP_ID,
      dryRun: true,
    })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { salary_run_id: RUN_ID, employee_id: EMP_ID, would_remove: true },
    })
  })

  it('answers the removal', async () => {
    services.removeEmployeeFromRun.mockResolvedValue({ ok: true, data: { deleted: true, employee_id: EMP_ID } })
    const outcome = await salaryRunsEmployeesRemove.run(ctx, { salary_run_id: RUN_ID, employee_id: EMP_ID }, { dryRun: false })
    expect(services.removeEmployeeFromRun).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ dryRun: false }))
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(salaryRunsEmployeesRemove.output.parse(outcome.data)).toEqual({
      salary_run_id: RUN_ID,
      employee_id: EMP_ID,
      removed: true,
    })
  })

  it('passes a refusal through with its code and details', async () => {
    services.removeEmployeeFromRun.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEES_NOT_DRAFT',
      details: { current_status: 'review' },
    })
    expect(await salaryRunsEmployeesRemove.run(ctx, { salary_run_id: RUN_ID, employee_id: EMP_ID }, { dryRun: true })).toEqual({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEES_NOT_DRAFT',
      details: { current_status: 'review' },
    })
  })
})

// ---------------------------------------------------------------------------
// salary-runs.lines.create
// ---------------------------------------------------------------------------

const BONUS = {
  salary_run_id: RUN_ID,
  employee_id: EMP_ID,
  item_type: 'bonus',
  description: 'Kvartalsbonus Q2',
  amount: 5000,
  one_off_tax_percent: 30,
}

const LINE_ROW = {
  salary_run_employee_id: SRE_ID,
  company_id: COMPANY_ID,
  item_type: 'bonus',
  description: 'Kvartalsbonus Q2',
  quantity: null,
  unit_price: null,
  amount: 5000,
  is_taxable: true,
  is_avgift_basis: true,
  is_vacation_basis: true,
  is_gross_deduction: false,
  is_net_deduction: false,
  account_number: '7210',
  sort_order: 0,
  one_off_tax_percent: 30,
  vacation_category: null,
  vacation_saved_year: null,
}

describe('salary-runs.lines.create', () => {
  it('accepts pay, deductions and vacation days, filling the flag defaults', () => {
    expect(salaryRunsLinesCreate.input.parse(BONUS)).toMatchObject({
      ...BONUS,
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: true,
      is_gross_deduction: false,
      is_net_deduction: false,
      sort_order: 0,
    })
    expect(
      accepts(salaryRunsLinesCreate, {
        salary_run_id: RUN_ID,
        employee_id: EMP_ID,
        item_type: 'net_deduction_advance',
        description: 'Avdrag förskott',
        amount: -2000,
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_net_deduction: true,
        account_number: '1613',
      }),
    ).toBe(true)
    expect(
      accepts(salaryRunsLinesCreate, {
        salary_run_id: RUN_ID,
        employee_id: EMP_ID,
        item_type: 'vacation',
        description: 'Semester',
        quantity: 3,
        amount: 0,
        vacation_category: 'saved',
        vacation_saved_year: '2024',
      }),
    ).toBe(true)
  })

  it('refuses what the v1 body refuses', () => {
    // Derived-only: a manual öresavrundning row would unbalance the verifikat.
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, item_type: 'oresavrundning' })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, item_type: 'tips' })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, description: '' })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, one_off_tax_percent: 101 })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, vacation_category: 'sick' })).toBe(false)
    // Account numbers are identifiers, never numbers.
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, account_number: 7210 })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, employee_id: undefined })).toBe(false)
    expect(accepts(salaryRunsLinesCreate, { ...BONUS, salary_run_employee_id: SRE_ID, employee_id: undefined })).toBe(false)
  })

  it('previews the line from the service dry run, addressing the employee by employee_id', async () => {
    services.createPayslipLine.mockResolvedValue({ ok: true, data: { ...LINE_ROW, id: null } })
    const input = salaryRunsLinesCreate.input.parse(BONUS)

    const outcome = await salaryRunsLinesCreate.run(ctx, input, { dryRun: true })

    const { salary_run_id: _run, employee_id: _emp, ...line } = input
    expect(services.createPayslipLine).toHaveBeenCalledWith(ctx.supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      target: { employeeId: EMP_ID },
      input: line,
      dryRun: true,
    })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { salary_run_id: RUN_ID, employee_id: EMP_ID, item_type: 'bonus', amount: 5000, account_number: '7210' },
    })
    expect(outcome.ok && outcome.dryRun && 'salary_line_item_id' in outcome.preview).toBe(false)
  })

  it('answers the stored line with qualified ids', async () => {
    services.createPayslipLine.mockResolvedValue({
      ok: true,
      data: { ...LINE_ROW, id: LINE_ID, created_at: 'x', updated_at: 'x' },
    })

    const outcome = await salaryRunsLinesCreate.run(ctx, salaryRunsLinesCreate.input.parse(BONUS), { dryRun: false })

    expect(services.createPayslipLine).toHaveBeenCalledWith(ctx.supabase, expect.objectContaining({ dryRun: false }))
    expect(outcome).toMatchObject({ ok: true, created: true })
    if (!outcome.ok || outcome.dryRun) return
    const { company_id: _company, ...fields } = LINE_ROW
    expect(salaryRunsLinesCreate.output.parse(outcome.data)).toEqual({
      ...fields,
      salary_line_item_id: LINE_ID,
      salary_run_id: RUN_ID,
      employee_id: EMP_ID,
    })
  })

  it('passes a refusal through with its code and details', async () => {
    const refusal = {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'one_off_tax_percent', message: 'Engångsskatt kräver ...' },
    }
    services.createPayslipLine.mockResolvedValue(refusal)
    expect(await salaryRunsLinesCreate.run(ctx, salaryRunsLinesCreate.input.parse(BONUS), { dryRun: true })).toEqual(refusal)

    services.createPayslipLine.mockResolvedValue({ ok: false, code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND' })
    expect(await salaryRunsLinesCreate.run(ctx, salaryRunsLinesCreate.input.parse(BONUS), { dryRun: true })).toEqual({
      ok: false,
      code: 'SALARY_RUN_EMPLOYEE_NOT_FOUND',
      details: undefined,
    })
  })

  it('titles the approval with the line text and the amount the service will store', () => {
    expect(salaryRunsLinesCreate.mcp!.stage!.title({ ...BONUS, amount: 1234.565 })).toBe(
      'Lägg till lönebeskedsrad: Kvartalsbonus Q2 (1234.57 kr)',
    )
  })
})

// ---------------------------------------------------------------------------
// salary-runs.lines.delete
// ---------------------------------------------------------------------------

describe('salary-runs.lines.delete', () => {
  const input = { salary_run_id: RUN_ID, salary_line_item_id: LINE_ID }

  it('takes the run and the line id', () => {
    expect(accepts(salaryRunsLinesDelete, input)).toBe(true)
    expect(accepts(salaryRunsLinesDelete, { salary_run_id: RUN_ID })).toBe(false)
    expect(accepts(salaryRunsLinesDelete, { ...input, salary_line_item_id: 'line-1' })).toBe(false)
  })

  it('previews the deletion from the service dry run', async () => {
    services.deletePayslipLine.mockResolvedValue({ ok: true, data: { deleted: true, salary_line_item_id: LINE_ID } })

    const outcome = await salaryRunsLinesDelete.run(ctx, input, { dryRun: true })

    expect(services.deletePayslipLine).toHaveBeenCalledWith(ctx.supabase, {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      lineId: LINE_ID,
      dryRun: true,
    })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { ...input, would_delete: true } })
  })

  it('answers the deletion', async () => {
    services.deletePayslipLine.mockResolvedValue({ ok: true, data: { deleted: true, salary_line_item_id: LINE_ID } })
    const outcome = await salaryRunsLinesDelete.run(ctx, input, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(salaryRunsLinesDelete.output.parse(outcome.data)).toEqual({ ...input, deleted: true })
  })

  it('passes a refusal through with its code', async () => {
    services.deletePayslipLine.mockResolvedValue({ ok: false, code: 'SALARY_LINE_NOT_FOUND' })
    expect(await salaryRunsLinesDelete.run(ctx, input, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'SALARY_LINE_NOT_FOUND',
    })
  })
})

// ---------------------------------------------------------------------------
// salary-runs.correct
// ---------------------------------------------------------------------------

const ORIGINAL = {
  id: RUN_ID,
  status: 'booked',
  period_year: 2026,
  period_month: 5,
  payment_date: '2026-05-25',
  voucher_series: 'L',
  deviation_period_start: '2026-04-01',
  deviation_period_end: '2026-04-30',
}

const CORRECTION = {
  period_year: 2026,
  period_month: 5,
  payment_date: '2026-05-25',
  voucher_series: 'L',
  deviation_period_start: '2026-04-01',
  deviation_period_end: '2026-04-30',
  status: 'draft',
  is_correction: true,
  corrects_run_id: RUN_ID,
}

describe('salary-runs.correct', () => {
  const input = { salary_run_id: RUN_ID }

  it('takes the booked run', () => {
    expect(accepts(salaryRunsCorrect, input)).toBe(true)
    expect(accepts(salaryRunsCorrect, {})).toBe(false)
    expect(accepts(salaryRunsCorrect, { salary_run_id: 'run-1' })).toBe(false)
  })

  it('previews the stornos and the draft from the service dry run', async () => {
    services.correctSalaryRun.mockResolvedValue({
      ok: true,
      dryRun: true,
      preview: { original_run: ORIGINAL, entries_to_reverse: ENTRY_IDS, correction_run: CORRECTION },
    })

    const outcome = await salaryRunsCorrect.run(ctx, input, { dryRun: true })

    expect(services.correctSalaryRun).toHaveBeenCalledWith(ctx.supabase, {
      companyId: COMPANY_ID,
      userId: USER_ID,
      runId: RUN_ID,
      dryRun: true,
    })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        salary_run_id: RUN_ID,
        period_year: 2026,
        period_month: 5,
        would_change_status_from: 'booked',
        would_change_status_to: 'corrected',
        resumes_earlier_correction: false,
        would_reverse_entry_ids: ENTRY_IDS,
        would_create_correction_run: CORRECTION,
      },
    })
  })

  it('answers the correction run and the reversed verifikat, logging non-fatal warnings', async () => {
    services.correctSalaryRun.mockResolvedValue({
      ok: true,
      dryRun: false,
      originalRunId: RUN_ID,
      correctionRun: { ...CORRECTION, id: CORRECTION_RUN_ID, company_id: COMPANY_ID, notes: 'Korrigering' },
      reversedEntryIds: ENTRY_IDS,
      stampedAt: '2026-06-02T10:00:00.000Z',
      warnings: ['employee x was not copied to the correction run'],
    })

    const outcome = await salaryRunsCorrect.run(ctx, input, { dryRun: false })

    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(salaryRunsCorrect.output.parse(outcome.data)).toEqual({
      original_run_id: RUN_ID,
      original_status: 'corrected',
      correction_run: {
        salary_run_id: CORRECTION_RUN_ID,
        period_year: 2026,
        period_month: 5,
        payment_date: '2026-05-25',
        status: 'draft',
        is_correction: true,
        corrects_run_id: RUN_ID,
        deviation_period_start: '2026-04-01',
        deviation_period_end: '2026-04-30',
      },
      reversed_entry_ids: ENTRY_IDS,
      warnings: ['employee x was not copied to the correction run'],
    })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('passes the precondition refusals through with their details', async () => {
    services.correctSalaryRun.mockResolvedValue({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
    expect(await salaryRunsCorrect.run(ctx, input, { dryRun: true })).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })

    services.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_CORRECT_NOT_BOOKED',
      details: { current_status: 'approved' },
    })
    expect(await salaryRunsCorrect.run(ctx, input, { dryRun: true })).toEqual({
      ok: false,
      code: 'SALARY_RUN_CORRECT_NOT_BOOKED',
      details: { current_status: 'approved' },
    })

    const already = {
      ok: false,
      code: 'SALARY_RUN_ALREADY_CORRECTED',
      details: { current_status: 'corrected', correction_run_id: CORRECTION_RUN_ID, reason: 'status_corrected' },
    }
    services.correctSalaryRun.mockResolvedValue(already)
    expect(await salaryRunsCorrect.run(ctx, input, { dryRun: true })).toEqual(already)
  })

  it('hands a storno that failed before anything was posted to the door as it is', async () => {
    const periodLocked = Object.assign(new Error('Perioden är låst'), { code: 'PERIOD_LOCKED' })
    services.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'REVERSAL_FAILED',
      error: periodLocked,
      details: { entry_id: ENTRY_IDS[0], reversed_entry_ids: [], remaining_entry_ids: ENTRY_IDS.slice(1) },
    })

    const outcome = await salaryRunsCorrect.run(ctx, input, { dryRun: false })

    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.error).toBe(periodLocked)
  })

  it('reports a storno that failed after others were posted as a partial commit naming them', async () => {
    const cause = new Error('Perioden är låst')
    services.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'REVERSAL_FAILED',
      error: cause,
      details: { entry_id: ENTRY_IDS[1], reversed_entry_ids: [ENTRY_IDS[0]], remaining_entry_ids: [ENTRY_IDS[2]] },
    })

    const outcome = await salaryRunsCorrect.run(ctx, input, { dryRun: false })

    const error = !outcome.ok ? outcome.error : undefined
    expect(error).toBeInstanceOf(PartialCommitError)
    expect((error as PartialCommitError).postedIds).toEqual({ reversed_journal_entry_id_1: ENTRY_IDS[0] })
    expect((error as PartialCommitError).cause).toBe(cause)
    expect((error as PartialCommitError).message).toContain('1 of 3')
  })

  it('reports a correction run that could not be created after the stornos as a partial commit', async () => {
    const dbError = { code: '57014', message: 'statement timeout' }
    services.correctSalaryRun.mockResolvedValue({ ok: false, code: 'DB_ERROR', stage: 'insert_correction_run', error: dbError })

    const outcome = await salaryRunsCorrect.run(ctx, input, { dryRun: false })

    const error = !outcome.ok ? outcome.error : undefined
    expect(error).toBeInstanceOf(PartialCommitError)
    expect((error as PartialCommitError).postedIds).toEqual({ corrected_salary_run_id: RUN_ID })
    expect((error as PartialCommitError).message).toContain('statement timeout')
  })

  it('hands a failed read of the run to the door as it is', async () => {
    const dbError = { code: '57014', message: 'statement timeout' }
    services.correctSalaryRun.mockResolvedValue({ ok: false, code: 'DB_ERROR', stage: 'load_run', error: dbError })
    expect(await salaryRunsCorrect.run(ctx, input, { dryRun: true })).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error: dbError })
  })
})

// ---------------------------------------------------------------------------
// salary-runs.mark-paid
// ---------------------------------------------------------------------------

describe('salary-runs.mark-paid', () => {
  const input = { salary_run_id: RUN_ID }

  it('takes the approved run and nothing else it needs', () => {
    expect(accepts(salaryRunsMarkPaid, input)).toBe(true)
    expect(accepts(salaryRunsMarkPaid, {})).toBe(false)
    expect(accepts(salaryRunsMarkPaid, { salary_run_id: 'run-1' })).toBe(false)
  })

  it('previews the transition from the service dry run', async () => {
    const preview = { salary_run_id: RUN_ID, would_advance_status_from: 'approved', would_advance_status_to: 'paid' }
    services.markSalaryRunPaid.mockResolvedValue({ ok: true, dryRun: true, preview })

    const outcome = await salaryRunsMarkPaid.run(ctx, input, { dryRun: true })

    expect(services.markSalaryRunPaid).toHaveBeenCalledWith(ctx, RUN_ID, { dryRun: true })
    expect(outcome).toEqual({ ok: true, dryRun: true, preview })
  })

  it('answers the paid run with a qualified id', async () => {
    services.markSalaryRunPaid.mockResolvedValue({
      ok: true,
      data: { id: RUN_ID, status: 'paid', paid_at: '2026-05-25T08:00:00.000Z' },
    })
    const outcome = await salaryRunsMarkPaid.run(ctx, input, { dryRun: false })
    expect(services.markSalaryRunPaid).toHaveBeenCalledWith(ctx, RUN_ID, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(salaryRunsMarkPaid.output.parse(outcome.data)).toEqual({
      salary_run_id: RUN_ID,
      status: 'paid',
      paid_at: '2026-05-25T08:00:00.000Z',
    })
  })

  it('passes a refusal through with its code and details', async () => {
    const refusal = { ok: false, code: 'SALARY_RUN_MARK_PAID_NOT_APPROVED', details: { current_status: 'review' } }
    services.markSalaryRunPaid.mockResolvedValue(refusal)
    expect(await salaryRunsMarkPaid.run(ctx, input, { dryRun: true })).toEqual(refusal)
  })
})
