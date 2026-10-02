/**
 * Employee payroll setup over MCP (src/lib/operations/salary-employee-setup.ts):
 * worked days, benefits (förmåner), recurring payslip lines and the employee
 * soft delete. The services are mocked (their rules are tested in
 * lib/salary/__tests__); pinned here is the operation contract: each input
 * schema, the dry run as the staging preview (the service is asked with
 * dryRun true), the service result mapped into the output schema, and the
 * service's failure codes passing through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const svc = vi.hoisted(() => ({
  listWorkedDays: vi.fn(),
  upsertWorkedDays: vi.fn(),
  deleteWorkedDaysRange: vi.fn(),
  listEmployeeBenefits: vi.fn(),
  createEmployeeBenefit: vi.fn(),
  updateEmployeeBenefit: vi.fn(),
  deleteEmployeeBenefit: vi.fn(),
  listEmployeeRecurringLines: vi.fn(),
  createEmployeeRecurringLine: vi.fn(),
  updateEmployeeRecurringLine: vi.fn(),
  deleteEmployeeRecurringLine: vi.fn(),
  softDeleteEmployee: vi.fn(),
}))

// Partial mocks: the schemas, mappers and constants stay real.
vi.mock('@/lib/salary/worked-days', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/worked-days')>()),
  listWorkedDays: svc.listWorkedDays,
  upsertWorkedDays: svc.upsertWorkedDays,
  deleteWorkedDaysRange: svc.deleteWorkedDaysRange,
}))
vi.mock('@/lib/salary/employee-benefits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/employee-benefits')>()),
  listEmployeeBenefits: svc.listEmployeeBenefits,
  createEmployeeBenefit: svc.createEmployeeBenefit,
  updateEmployeeBenefit: svc.updateEmployeeBenefit,
  deleteEmployeeBenefit: svc.deleteEmployeeBenefit,
}))
vi.mock('@/lib/salary/employee-recurring-lines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/employee-recurring-lines')>()),
  listEmployeeRecurringLines: svc.listEmployeeRecurringLines,
  createEmployeeRecurringLine: svc.createEmployeeRecurringLine,
  updateEmployeeRecurringLine: svc.updateEmployeeRecurringLine,
  deleteEmployeeRecurringLine: svc.deleteEmployeeRecurringLine,
}))
vi.mock('@/lib/salary/employee-soft-delete', () => ({ softDeleteEmployee: svc.softDeleteEmployee }))

import { OperationError, throwOutcomeFailure } from '../errors'
import type { AnyOperation, OperationContext, OperationOutcome } from '../types'
import {
  employeesBenefitsCreate,
  employeesBenefitsDelete,
  employeesBenefitsList,
  employeesBenefitsUpdate,
  employeesDelete,
  employeesRecurringLinesCreate,
  employeesRecurringLinesDelete,
  employeesRecurringLinesList,
  employeesRecurringLinesUpdate,
  employeesWorkedDaysDelete,
  employeesWorkedDaysList,
  employeesWorkedDaysUpsert,
} from '../salary-employee-setup'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BENEFIT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const DAY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const RUN_ID = '11111111-1111-4111-8111-111111111111'
const STAMP = '2026-03-05T08:00:00Z'

const supabase = { tag: 'supabase' } as never
const ctx: OperationContext = { supabase, companyId: COMPANY_ID, userId: USER_ID, log: {} as never }

/** Parse the raw input as every door does, then run the operation. */
async function run(op: AnyOperation, raw: Record<string, unknown>, dryRun = false): Promise<OperationOutcome<unknown>> {
  return op.run(ctx, op.input.parse(raw), { dryRun })
}

function expectData(outcome: OperationOutcome<unknown>): Record<string, unknown> {
  if (!outcome.ok || outcome.dryRun) throw new Error(`expected committed data, got ${JSON.stringify(outcome)}`)
  return outcome.data as Record<string, unknown>
}

function expectPreview(outcome: OperationOutcome<unknown>): Record<string, unknown> {
  if (!outcome.ok || !outcome.dryRun) throw new Error(`expected a dry-run preview, got ${JSON.stringify(outcome)}`)
  return outcome.preview
}

function expectFailure(outcome: OperationOutcome<unknown>) {
  if (outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`)
  return outcome
}

const accepts = (op: AnyOperation, raw: Record<string, unknown>) => op.input.safeParse(raw).success

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// The contract every operation here meets
// ---------------------------------------------------------------------------

const EXPECTED = [
  { op: employeesWorkedDaysList, id: 'employees.worked-days.list', kind: 'read', scope: 'payroll:read', risk: 'low', tool: 'gnubok_list_worked_days' },
  { op: employeesWorkedDaysUpsert, id: 'employees.worked-days.upsert', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_set_worked_days', pendingType: 'set_worked_days' },
  { op: employeesWorkedDaysDelete, id: 'employees.worked-days.delete', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_delete_worked_days', pendingType: 'delete_worked_days' },
  { op: employeesBenefitsList, id: 'employees.benefits.list', kind: 'read', scope: 'payroll:read', risk: 'low', tool: 'gnubok_list_employee_benefits' },
  { op: employeesBenefitsCreate, id: 'employees.benefits.create', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_add_employee_benefit', pendingType: 'add_employee_benefit' },
  { op: employeesBenefitsUpdate, id: 'employees.benefits.update', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_update_employee_benefit', pendingType: 'update_employee_benefit' },
  { op: employeesBenefitsDelete, id: 'employees.benefits.delete', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_delete_employee_benefit', pendingType: 'delete_employee_benefit' },
  { op: employeesRecurringLinesList, id: 'employees.recurring-lines.list', kind: 'read', scope: 'payroll:read', risk: 'low', tool: 'gnubok_list_employee_recurring_lines' },
  { op: employeesRecurringLinesCreate, id: 'employees.recurring-lines.create', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_add_employee_recurring_line', pendingType: 'add_employee_recurring_line' },
  { op: employeesRecurringLinesUpdate, id: 'employees.recurring-lines.update', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_update_employee_recurring_line', pendingType: 'update_employee_recurring_line' },
  { op: employeesRecurringLinesDelete, id: 'employees.recurring-lines.delete', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_delete_employee_recurring_line', pendingType: 'delete_employee_recurring_line' },
  { op: employeesDelete, id: 'employees.delete', kind: 'write', scope: 'payroll:write', risk: 'medium', tool: 'gnubok_delete_employee', pendingType: 'delete_employee' },
] as const

/** A valid input per write, for the staging round trip. */
const VALID_WRITE_INPUT: Record<string, Record<string, unknown>> = {
  'employees.worked-days.upsert': {
    employee_id: EMPLOYEE_ID,
    days: [
      { work_date: '2026-03-03', hours: 4, notes: 'Halvdag' },
      { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
    ],
  },
  'employees.worked-days.delete': { employee_id: EMPLOYEE_ID, from: '2026-03-02', to: '2026-03-03' },
  'employees.benefits.create': {
    employee_id: EMPLOYEE_ID,
    benefit_type: 'car',
    description: 'Bilförmån Volvo XC40',
    monthly_value: 4275,
    valid_from: '2026-01-01',
  },
  'employees.benefits.update': { employee_id: EMPLOYEE_ID, employee_benefit_id: BENEFIT_ID, valid_to: null },
  'employees.benefits.delete': { employee_id: EMPLOYEE_ID, employee_benefit_id: BENEFIT_ID },
  'employees.recurring-lines.create': {
    employee_id: EMPLOYEE_ID,
    item_type: 'net_deduction_union',
    description: 'Fackavgift',
    amount: -350,
    account_number: '2790',
    valid_from: '2026-01-01',
  },
  'employees.recurring-lines.update': { employee_id: EMPLOYEE_ID, employee_recurring_line_id: LINE_ID, amount: -700 },
  'employees.recurring-lines.delete': { employee_id: EMPLOYEE_ID, employee_recurring_line_id: LINE_ID },
  'employees.delete': { employee_id: EMPLOYEE_ID },
}

/** Every property path whose key is a bare `id`, in a JSON Schema. */
function bareIdPaths(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return []
  const node = schema as { properties?: Record<string, unknown>; items?: unknown }
  const found: string[] = []
  if (node.properties) {
    if ('id' in node.properties) found.push(path)
    for (const [key, child] of Object.entries(node.properties)) found.push(...bareIdPaths(child, `${path}.${key}`))
  }
  if (node.items) found.push(...bareIdPaths(node.items, `${path}[]`))
  return found
}

describe('operation contract', () => {
  it.each(EXPECTED)('$id: v1 id, kind, scope and risk; MCP-only; search-only tool', (row) => {
    const op = row.op as AnyOperation
    expect(op.id).toBe(row.id)
    expect(op.kind).toBe(row.kind)
    expect(op.scope).toBe(row.scope)
    expect(op.risk).toBe(row.risk)
    expect(op.http, 'no http binding: the v1 door is the hand-written route').toBeUndefined()
    expect(op.mcp?.name).toBe(row.tool)
    expect(op.mcp?.visibility, 'search-only by default: zero tools/list cost').toBeUndefined()
    expect(op.input instanceof z.ZodObject).toBe(true)
  })

  it.each(EXPECTED)('$id: description within budget; writes stage, reads do not', (row) => {
    const op = row.op as AnyOperation
    const description = op.mcp!.description ?? op.docs.summary
    expect(description.length).toBeLessThanOrEqual(280)
    expect(description).not.toMatch(/Args:|Returns:|Examples:/)
    if (row.kind === 'write') {
      expect(description).toMatch(/\bstage\b/i)
      expect(op.mcp!.stage?.pendingType).toBe(row.pendingType)
    } else {
      expect(op.mcp!.stage).toBeUndefined()
    }
  })

  it.each(EXPECTED)('$id: lowercase Swedish keywords', (row) => {
    const keywords = (row.op as AnyOperation).mcp!.keywords ?? []
    expect(keywords.length).toBeGreaterThan(0)
    for (const keyword of keywords) expect(keyword).toBe(keyword.toLowerCase())
  })

  it.each(EXPECTED)('$id: schemas render as JSON Schema; the output has qualified ids only', (row) => {
    const op = row.op as AnyOperation
    const input = z.toJSONSchema(op.input as unknown as z.ZodTypeAny, { io: 'input', unrepresentable: 'any' }) as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(input.properties)).toContain('employee_id')
    const output = z.toJSONSchema(op.output as unknown as z.ZodTypeAny, { io: 'output', unrepresentable: 'any' })
    expect(bareIdPaths(output)).toEqual([])
  })

  it.each(EXPECTED.filter((row) => row.kind === 'write'))(
    '$id: staged params survive the round trip to the commit, and the approval title is Swedish',
    (row) => {
      const op = row.op as AnyOperation
      const parsed = op.input.parse(VALID_WRITE_INPUT[row.id])
      // pending_operations.params is JSON; the commit parses it again.
      const restaged = op.input.parse(JSON.parse(JSON.stringify(parsed)))
      expect(restaged).toEqual(parsed)
      const title = op.mcp!.stage!.title(parsed as Record<string, unknown>)
      expect(title.length).toBeGreaterThan(0)
      expect(title).not.toMatch(/undefined|null|\[object/)
    },
  )

  it('never uses an em or en dash in what an agent or approver reads', () => {
    for (const row of EXPECTED) {
      const op = row.op as AnyOperation
      const text = JSON.stringify([op.docs, op.mcp?.description, op.mcp?.title, op.mcp?.keywords])
      expect(text, op.id).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

// ---------------------------------------------------------------------------
// Worked days
// ---------------------------------------------------------------------------

const WORKED_ROW = {
  id: DAY_ID,
  work_date: '2026-03-02',
  // PostgREST can hand a numeric column back as a string.
  hours: '8.5' as unknown as number,
  start_time: '22:00:00',
  end_time: '06:00:00',
  notes: null,
  salary_run_employee_id: null,
  created_at: STAMP,
  updated_at: STAMP,
}

const LOCK_DETAILS = {
  salary_run_id: RUN_ID,
  status: 'review',
  period_year: 2026,
  period_month: 3,
  deviation_period_start: '2026-03-01',
  deviation_period_end: '2026-03-31',
  locked_dates: ['2026-03-02', '2026-03-03'],
}

describe('employees.worked-days.list (gnubok_list_worked_days)', () => {
  const op = employeesWorkedDaysList

  it('accepts a range of up to 92 days and refuses anything else', () => {
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-01-01', to: '2026-04-02' })).toBe(true) // 92 days
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-01-01', to: '2026-04-03' })).toBe(false) // 93 days
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-03-31', to: '2026-03-01' })).toBe(false)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-3-1', to: '2026-03-31' })).toBe(false)
    expect(accepts(op, { employee_id: 'not-a-uuid', from: '2026-03-01', to: '2026-03-31' })).toBe(false)
    expect(accepts(op, { from: '2026-03-01', to: '2026-03-31' })).toBe(false)
  })

  it('lists the rows as the v1 resource, hours as a number', async () => {
    svc.listWorkedDays.mockResolvedValue({ ok: true, data: [WORKED_ROW] })

    const data = expectData(await run(op, { employee_id: EMPLOYEE_ID, from: '2026-03-01', to: '2026-03-31' }))

    expect(svc.listWorkedDays).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
    })
    expect(op.output.parse(data)).toEqual({
      employee_id: EMPLOYEE_ID,
      from: '2026-03-01',
      to: '2026-03-31',
      worked_days: [
        {
          salary_worked_day_id: DAY_ID,
          work_date: '2026-03-02',
          hours: 8.5,
          start_time: '22:00:00',
          end_time: '06:00:00',
          notes: null,
          created_at: STAMP,
          updated_at: STAMP,
        },
      ],
    })
  })

  it('passes EMPLOYEE_NOT_FOUND through', async () => {
    svc.listWorkedDays.mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    const failure = expectFailure(await run(op, { employee_id: EMPLOYEE_ID, from: '2026-03-01', to: '2026-03-31' }))
    expect(failure.code).toBe('EMPLOYEE_NOT_FOUND')
  })
})

describe('employees.worked-days.upsert (gnubok_set_worked_days)', () => {
  const op = employeesWorkedDaysUpsert
  const valid = VALID_WRITE_INPUT['employees.worked-days.upsert']
  const day = (extra: Record<string, unknown>) => ({ employee_id: EMPLOYEE_ID, days: [{ work_date: '2026-03-02', hours: 8, ...extra }] })

  it('validates the days as the v1 PUT does', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, day({}))).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, days: [] })).toBe(false)
    expect(accepts(op, day({ hours: 0 }))).toBe(false)
    expect(accepts(op, day({ hours: 24.5 }))).toBe(false)
    expect(accepts(op, day({ start_time: '22:00' }))).toBe(false) // both or neither
    expect(accepts(op, day({ start_time: '10pm', end_time: '06:00' }))).toBe(false)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, days: [{ work_date: '2026-03-02' }] })).toBe(false) // hours required
    const tooMany = Array.from({ length: 93 }, (_, i) => ({
      work_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      hours: 8,
    }))
    expect(accepts(op, { employee_id: EMPLOYEE_ID, days: tooMany })).toBe(false)
  })

  it('dry run: asks the service with dryRun true and previews the days as they would be stored', async () => {
    const previewDays = [
      { work_date: '2026-03-03', hours: 4, start_time: null, end_time: null, notes: 'Halvdag' },
      { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00', notes: null },
    ]
    svc.upsertWorkedDays.mockResolvedValue({ ok: true, data: { count: 2, days: previewDays } })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.upsertWorkedDays).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      // omitted optional fields are sent as null: the upsert clears them
      days: [
        { work_date: '2026-03-03', hours: 4, start_time: null, end_time: null, notes: 'Halvdag' },
        { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00', notes: null },
      ],
      dryRun: true,
    })
    expect(preview).toMatchObject({ employee_id: EMPLOYEE_ID, count: 2, from: '2026-03-02', to: '2026-03-03', days: previewDays })
  })

  it('commit: maps the stored rows into the output', async () => {
    svc.upsertWorkedDays.mockResolvedValue({ ok: true, data: { count: 1, days: [WORKED_ROW] } })

    const data = expectData(await run(op, day({ start_time: '22:00', end_time: '06:00' })))

    expect(svc.upsertWorkedDays.mock.calls[0][1].dryRun).toBe(false)
    expect(op.output.parse(data)).toMatchObject({
      employee_id: EMPLOYEE_ID,
      count: 1,
      worked_days: [{ salary_worked_day_id: DAY_ID, hours: 8.5 }],
    })
  })

  it('maps the 24h cap to the registered ABSENCE_HOURS_CONFLICT, as v1 does', async () => {
    svc.upsertWorkedDays.mockResolvedValue({
      ok: false,
      code: 'WORKED_HOURS_CONFLICT',
      details: { message: 'Total tid för 2026-03-02 överstiger 24 timmar', pg_code: '23514' },
    })
    const failure = expectFailure(await run(op, valid, true))
    expect(failure.code).toBe('ABSENCE_HOURS_CONFLICT')
    expect(failure.messageSv).toMatch(/24 timmar/)
  })

  it('passes the register lock through and names the run in the message', async () => {
    svc.upsertWorkedDays.mockResolvedValue({ ok: false, code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN', details: LOCK_DETAILS })

    const failure = expectFailure(await run(op, valid, true))

    expect(failure.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(failure.details).toEqual(LOCK_DETAILS)
    expect(failure.messageSv).toContain(RUN_ID)
    expect(failure.messageSv).toContain('2026-03-02 till 2026-03-03')
  })

  it('surfaces the field-level message of a validation failure, never raw database text', async () => {
    svc.upsertWorkedDays.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'days', message: 'Each work_date may appear at most once per request.', duplicate_dates: ['2026-03-02'] },
    })
    expect(expectFailure(await run(op, valid, true)).messageSv).toBe(
      'days: Each work_date may appear at most once per request.',
    )

    svc.upsertWorkedDays.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { message: 'new row violates check constraint "salary_worked_days_hours_check"', pg_code: '23514' },
    })
    expect(expectFailure(await run(op, valid, true)).messageSv).toBeUndefined()
  })

  it('titles the approval with the day count and the dates', () => {
    const input = op.input.parse(valid) as Record<string, unknown>
    expect(op.mcp!.stage!.title(input)).toBe('Registrera arbetade timmar (2 dagar, 2026-03-02 till 2026-03-03)')
    expect(op.mcp!.stage!.title(op.input.parse(day({})) as Record<string, unknown>)).toBe(
      'Registrera arbetade timmar (1 dag, 2026-03-02)',
    )
  })
})

describe('employees.worked-days.delete (gnubok_delete_worked_days)', () => {
  const op = employeesWorkedDaysDelete
  const valid = VALID_WRITE_INPUT['employees.worked-days.delete']

  it('takes an ordered range, with no 92-day cap (the v1 DELETE has none)', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-01-01', to: '2026-12-31' })).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-03-03', to: '2026-03-02' })).toBe(false)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, from: '2026-03-02' })).toBe(false)
  })

  it('dry run: counts what would be deleted through the service, with dryRun true', async () => {
    svc.deleteWorkedDaysRange.mockResolvedValue({ ok: true, data: { deleted_count: 2 } })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.deleteWorkedDaysRange).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-03-02',
      to: '2026-03-03',
      dryRun: true,
    })
    expect(preview).toEqual({ employee_id: EMPLOYEE_ID, from: '2026-03-02', to: '2026-03-03', would_delete_count: 2 })
  })

  it('commit: answers deleted_count', async () => {
    svc.deleteWorkedDaysRange.mockResolvedValue({ ok: true, data: { deleted_count: 0 } })
    const data = expectData(await run(op, valid))
    expect(op.output.parse(data)).toEqual({ employee_id: EMPLOYEE_ID, from: '2026-03-02', to: '2026-03-03', deleted_count: 0 })
  })

  it('passes the register lock and EMPLOYEE_NOT_FOUND through', async () => {
    svc.deleteWorkedDaysRange.mockResolvedValue({ ok: false, code: 'SALARY_REGISTER_DATES_LOCKED_BY_RUN', details: LOCK_DETAILS })
    expect(expectFailure(await run(op, valid, true)).code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    svc.deleteWorkedDaysRange.mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(expectFailure(await run(op, valid, true)).code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('titles the approval with the range', () => {
    expect(employeesWorkedDaysDelete.mcp!.stage!.title(op.input.parse(valid) as Record<string, unknown>)).toBe(
      'Ta bort arbetade timmar 2026-03-02 till 2026-03-03',
    )
  })
})

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

const BENEFIT_ROW = {
  id: BENEFIT_ID,
  employee_id: EMPLOYEE_ID,
  benefit_type: 'car' as const,
  description: 'Bilförmån Volvo XC40',
  monthly_value: 4275,
  valid_from: '2026-01-01',
  valid_to: null,
  metadata: {},
  is_active: true,
  created_at: STAMP,
  updated_at: STAMP,
}

const BENEFIT_RESOURCE = {
  employee_benefit_id: BENEFIT_ID,
  benefit_type: 'car',
  description: 'Bilförmån Volvo XC40',
  monthly_value: 4275,
  annual_market_value: null,
  valid_from: '2026-01-01',
  valid_to: null,
  is_active: true,
  metadata: {},
  created_at: STAMP,
  updated_at: STAMP,
}

describe('employees.benefits.list (gnubok_list_employee_benefits)', () => {
  const op = employeesBenefitsList

  it('takes an optional active filter as a boolean', () => {
    expect(accepts(op, { employee_id: EMPLOYEE_ID })).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, active: false })).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID, active: 'true' })).toBe(false)
  })

  it('lists the rows as the v1 resource', async () => {
    svc.listEmployeeBenefits.mockResolvedValue({ ok: true, data: [BENEFIT_ROW] })

    const data = expectData(await run(op, { employee_id: EMPLOYEE_ID, active: true }))

    expect(svc.listEmployeeBenefits).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      active: true,
    })
    expect(op.output.parse(data)).toEqual({ employee_id: EMPLOYEE_ID, benefits: [BENEFIT_RESOURCE] })
  })

  it('passes EMPLOYEE_NOT_FOUND through', async () => {
    svc.listEmployeeBenefits.mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(expectFailure(await run(op, { employee_id: EMPLOYEE_ID })).code).toBe('EMPLOYEE_NOT_FOUND')
  })
})

describe('employees.benefits.create (gnubok_add_employee_benefit)', () => {
  const op = employeesBenefitsCreate
  const valid = VALID_WRITE_INPUT['employees.benefits.create']

  it('validates as the v1 POST does: monthly_value per type, bike by market value, ordered dates', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, { ...valid, monthly_value: undefined })).toBe(false)
    expect(accepts(op, { ...valid, monthly_value: -1 })).toBe(false)
    expect(accepts(op, { ...valid, benefit_type: 'boat' })).toBe(false)
    expect(accepts(op, { ...valid, valid_to: '2025-12-31' })).toBe(false)
    expect(
      accepts(op, { ...valid, benefit_type: 'bike', monthly_value: undefined, annual_market_value: 15000 }),
    ).toBe(true)
    expect(accepts(op, { ...valid, employee_id: undefined })).toBe(false)
  })

  it('dry run: hands the input to the service as sent (no computation here), with dryRun true', async () => {
    const { employee_id: _employeeId, ...input } = valid
    const preview = {
      employee_id: EMPLOYEE_ID,
      benefit_type: 'car',
      description: 'Bilförmån Volvo XC40',
      monthly_value: 4275,
      valid_from: '2026-01-01',
      valid_to: null,
      metadata: {},
      is_active: true,
    }
    svc.createEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: false, preview } })

    const outcome = expectPreview(await run(op, valid, true))

    expect(svc.createEmployeeBenefit).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input,
      dryRun: true,
    })
    expect(outcome).toEqual({
      employee_id: EMPLOYEE_ID,
      benefit_type: 'car',
      description: 'Bilförmån Volvo XC40',
      monthly_value: 4275,
      annual_market_value: null,
      valid_from: '2026-01-01',
      valid_to: null,
      is_active: true,
      metadata: {},
    })
  })

  it('commit: answers the created row', async () => {
    svc.createEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: true, row: BENEFIT_ROW } })

    const outcome = await run(op, valid)

    expect(outcome).toMatchObject({ ok: true, created: true })
    expect(op.output.parse(expectData(outcome))).toEqual({ employee_id: EMPLOYEE_ID, ...BENEFIT_RESOURCE })
  })

  it('passes a validation failure through with its field message', async () => {
    svc.createEmployeeBenefit.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'valid_to', message: 'Gäller till måste vara efter Gäller från.' },
    })
    const failure = expectFailure(await run(op, valid, true))
    expect(failure.code).toBe('VALIDATION_ERROR')
    // MCP shows the message: the thrown error carries the code and the field message.
    expect(() => throwOutcomeFailure(failure)).toThrow(OperationError)
    expect(() => throwOutcomeFailure(failure)).toThrow('valid_to: Gäller till måste vara efter Gäller från.')
  })

  it('titles the approval with the description', () => {
    expect(op.mcp!.stage!.title(op.input.parse(valid) as Record<string, unknown>)).toBe('Lägg till förmån: Bilförmån Volvo XC40')
  })
})

describe('employees.benefits.update (gnubok_update_employee_benefit)', () => {
  const op = employeesBenefitsUpdate
  const ids = { employee_id: EMPLOYEE_ID, employee_benefit_id: BENEFIT_ID }

  it('needs at least one field to change; valid_to null clears the end date', () => {
    expect(accepts(op, ids)).toBe(false)
    expect(accepts(op, { ...ids, valid_to: null })).toBe(true)
    expect(accepts(op, { ...ids, monthly_value: 4500 })).toBe(true)
    expect(accepts(op, { ...ids, valid_from: '2026-06-01', valid_to: '2026-05-31' })).toBe(false)
    expect(accepts(op, { ...ids, benefit_type: 'bike' })).toBe(false) // not patchable: stripped, nothing left
    expect(accepts(op, { employee_id: EMPLOYEE_ID, valid_to: null })).toBe(false)
  })

  it('dry run: sends only the patch, with dryRun true, and previews the merged row', async () => {
    const merged = { ...BENEFIT_ROW, valid_to: '2026-06-30' }
    svc.updateEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: false, preview: merged } })

    const preview = expectPreview(await run(op, { ...ids, valid_to: '2026-06-30' }, true))

    expect(svc.updateEmployeeBenefit).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      benefitId: BENEFIT_ID,
      patch: { valid_to: '2026-06-30' },
      dryRun: true,
    })
    expect(preview).toEqual({ employee_id: EMPLOYEE_ID, ...BENEFIT_RESOURCE, valid_to: '2026-06-30' })
  })

  it('commit: answers the updated row', async () => {
    svc.updateEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: true, row: { ...BENEFIT_ROW, monthly_value: 4500 } } })
    const data = expectData(await run(op, { ...ids, monthly_value: 4500 }))
    expect(op.output.parse(data)).toEqual({ employee_id: EMPLOYEE_ID, ...BENEFIT_RESOURCE, monthly_value: 4500 })
  })

  it('passes NOT_FOUND through', async () => {
    svc.updateEmployeeBenefit.mockResolvedValue({ ok: false, code: 'NOT_FOUND', details: { resource: 'employee_benefit' } })
    expect(expectFailure(await run(op, { ...ids, is_active: false }, true)).code).toBe('NOT_FOUND')
  })
})

describe('employees.benefits.delete (gnubok_delete_employee_benefit)', () => {
  const op = employeesBenefitsDelete
  const valid = VALID_WRITE_INPUT['employees.benefits.delete']

  it('takes both ids', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, { employee_id: EMPLOYEE_ID })).toBe(false)
    expect(accepts(op, { ...valid, employee_benefit_id: 'ben_1' })).toBe(false)
  })

  it('dry run: previews the row that would be removed, through the service with dryRun true', async () => {
    svc.deleteEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: false, preview: BENEFIT_ROW } })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.deleteEmployeeBenefit).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      benefitId: BENEFIT_ID,
      dryRun: true,
    })
    expect(preview).toMatchObject({ employee_id: EMPLOYEE_ID, ...BENEFIT_RESOURCE })
    expect(preview.note).toMatch(/kept and switched off/)
  })

  it('commit: deleted, or kept and deactivated when a payslip line derives from it', async () => {
    svc.deleteEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: true, deleted: true } })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      employee_benefit_id: BENEFIT_ID,
      deleted: true,
      deactivated: false,
    })

    svc.deleteEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: true, deleted: false, deactivated: true } })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      employee_benefit_id: BENEFIT_ID,
      deleted: false,
      deactivated: true,
    })
  })

  it('answers NOT_FOUND when nothing matched, as the v1 route does', async () => {
    svc.deleteEmployeeBenefit.mockResolvedValue({ ok: true, data: { committed: true, deleted: false } })
    expect(expectFailure(await run(op, valid)).code).toBe('NOT_FOUND')

    svc.deleteEmployeeBenefit.mockResolvedValue({ ok: false, code: 'NOT_FOUND', details: { resource: 'employee_benefit' } })
    expect(expectFailure(await run(op, valid, true)).code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// Recurring payslip lines
// ---------------------------------------------------------------------------

const LINE_ROW = {
  id: LINE_ID,
  employee_id: EMPLOYEE_ID,
  company_id: COMPANY_ID,
  user_id: USER_ID,
  item_type: 'gross_deduction_other' as const,
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  account_number: null,
  valid_from: '2026-01-01',
  valid_to: null,
  metadata: {},
  is_active: true,
  created_at: STAMP,
  updated_at: STAMP,
}

const LINE_RESOURCE = {
  employee_recurring_line_id: LINE_ID,
  item_type: 'gross_deduction_other',
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  account_number: null,
  valid_from: '2026-01-01',
  valid_to: null,
  is_active: true,
  metadata: {},
  created_at: STAMP,
  updated_at: STAMP,
}

describe('employees.recurring-lines.list (gnubok_list_employee_recurring_lines)', () => {
  const op = employeesRecurringLinesList

  it('lists the lines as the v1 resource, without tenancy columns', async () => {
    svc.listEmployeeRecurringLines.mockResolvedValue({ ok: true, data: [LINE_ROW] })

    const data = expectData(await run(op, { employee_id: EMPLOYEE_ID, active: false }))

    expect(svc.listEmployeeRecurringLines).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      isActive: false,
    })
    expect(op.output.parse(data)).toEqual({ employee_id: EMPLOYEE_ID, recurring_lines: [LINE_RESOURCE] })
  })

  it('refuses a bad employee id and passes EMPLOYEE_NOT_FOUND through', async () => {
    expect(accepts(op, { employee_id: 'emp' })).toBe(false)
    svc.listEmployeeRecurringLines.mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(expectFailure(await run(op, { employee_id: EMPLOYEE_ID })).code).toBe('EMPLOYEE_NOT_FOUND')
  })
})

describe('employees.recurring-lines.create (gnubok_add_employee_recurring_line)', () => {
  const op = employeesRecurringLinesCreate
  const valid = VALID_WRITE_INPUT['employees.recurring-lines.create']

  it('validates as the v1 POST does: a negative amount, a four-digit account string', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, { ...valid, amount: 350 })).toBe(false)
    expect(accepts(op, { ...valid, amount: 0 })).toBe(false)
    expect(accepts(op, { ...valid, account_number: 2790 })).toBe(false)
    expect(accepts(op, { ...valid, account_number: '279' })).toBe(false)
    expect(accepts(op, { ...valid, item_type: 'addition_cash' })).toBe(false)
    expect(accepts(op, { ...valid, valid_to: '2025-12-31' })).toBe(false)
  })

  it('dry run: previews the would-be row through the service with dryRun true', async () => {
    const { employee_id: _employeeId, ...input } = valid
    svc.createEmployeeRecurringLine.mockResolvedValue({
      ok: true,
      data: { ...LINE_ROW, item_type: 'net_deduction_union', description: 'Fackavgift', amount: -350, account_number: '2790', id: null, created_at: null, updated_at: null },
    })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.createEmployeeRecurringLine).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      userId: USER_ID,
      input,
      dryRun: true,
    })
    expect(preview).toEqual({
      employee_id: EMPLOYEE_ID,
      item_type: 'net_deduction_union',
      description: 'Fackavgift',
      amount: -350,
      account_number: '2790',
      valid_from: '2026-01-01',
      valid_to: null,
      is_active: true,
      metadata: {},
    })
  })

  it('commit: answers the created line', async () => {
    svc.createEmployeeRecurringLine.mockResolvedValue({ ok: true, data: LINE_ROW })
    const outcome = await run(op, valid)
    expect(outcome).toMatchObject({ ok: true, created: true })
    expect(op.output.parse(expectData(outcome))).toEqual({ employee_id: EMPLOYEE_ID, ...LINE_RESOURCE })
  })

  it('passes a validation failure through with the first issue as the message', async () => {
    svc.createEmployeeRecurringLine.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { issues: [{ field: 'account_number', message: 'Kontonummer måste vara fyra siffror.' }] },
    })
    const failure = expectFailure(await run(op, valid, true))
    expect(failure.code).toBe('VALIDATION_ERROR')
    expect(failure.messageSv).toBe('account_number: Kontonummer måste vara fyra siffror.')
  })
})

describe('employees.recurring-lines.update (gnubok_update_employee_recurring_line)', () => {
  const op = employeesRecurringLinesUpdate
  const ids = { employee_id: EMPLOYEE_ID, employee_recurring_line_id: LINE_ID }

  it('needs at least one field to change; item_type is not patchable', () => {
    expect(accepts(op, ids)).toBe(false)
    expect(accepts(op, { ...ids, item_type: 'net_deduction_union' })).toBe(false)
    expect(accepts(op, { ...ids, account_number: null })).toBe(true)
    expect(accepts(op, { ...ids, valid_from: '2026-06-01', valid_to: '2026-05-31' })).toBe(false)
  })

  it('dry run: sends only the patch, with dryRun true, and previews the merged line', async () => {
    svc.updateEmployeeRecurringLine.mockResolvedValue({ ok: true, data: { ...LINE_ROW, amount: -700 } })

    const preview = expectPreview(await run(op, { ...ids, amount: -700 }, true))

    expect(svc.updateEmployeeRecurringLine).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      lineId: LINE_ID,
      patch: { amount: -700 },
      dryRun: true,
    })
    expect(preview).toEqual({ employee_id: EMPLOYEE_ID, ...LINE_RESOURCE, amount: -700 })
  })

  it('commit: answers the updated line', async () => {
    svc.updateEmployeeRecurringLine.mockResolvedValue({ ok: true, data: { ...LINE_ROW, valid_to: '2026-12-31' } })
    const data = expectData(await run(op, { ...ids, valid_to: '2026-12-31' }))
    expect(op.output.parse(data)).toEqual({ employee_id: EMPLOYEE_ID, ...LINE_RESOURCE, valid_to: '2026-12-31' })
  })

  it('passes NOT_FOUND through', async () => {
    svc.updateEmployeeRecurringLine.mockResolvedValue({
      ok: false,
      code: 'NOT_FOUND',
      details: { resource: 'employee_recurring_line', employee_recurring_line_id: LINE_ID },
    })
    expect(expectFailure(await run(op, { ...ids, is_active: false }, true)).code).toBe('NOT_FOUND')
  })
})

describe('employees.recurring-lines.delete (gnubok_delete_employee_recurring_line)', () => {
  const op = employeesRecurringLinesDelete
  const valid = VALID_WRITE_INPUT['employees.recurring-lines.delete']

  it('dry run: says whether the line would be deleted or deactivated, with dryRun true', async () => {
    svc.deleteEmployeeRecurringLine.mockResolvedValue({ ok: true, data: { id: LINE_ID, deleted: false, deactivated: true } })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.deleteEmployeeRecurringLine).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      lineId: LINE_ID,
      dryRun: true,
    })
    expect(preview).toEqual({
      employee_id: EMPLOYEE_ID,
      employee_recurring_line_id: LINE_ID,
      would_delete: false,
      would_deactivate: true,
    })
  })

  it('commit: deleted, or deactivated when a run derived from the line', async () => {
    svc.deleteEmployeeRecurringLine.mockResolvedValue({ ok: true, data: { id: LINE_ID, deleted: true } })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      employee_recurring_line_id: LINE_ID,
      deleted: true,
      deactivated: false,
    })

    svc.deleteEmployeeRecurringLine.mockResolvedValue({ ok: true, data: { id: LINE_ID, deleted: false, deactivated: true } })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      employee_recurring_line_id: LINE_ID,
      deleted: false,
      deactivated: true,
    })
  })

  it('refuses a bad line id and passes NOT_FOUND through', async () => {
    expect(accepts(op, { ...valid, employee_recurring_line_id: 'erl_1' })).toBe(false)
    svc.deleteEmployeeRecurringLine.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    expect(expectFailure(await run(op, valid, true)).code).toBe('NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// Remove an employee
// ---------------------------------------------------------------------------

describe('employees.delete (gnubok_delete_employee)', () => {
  const op = employeesDelete
  const valid = VALID_WRITE_INPUT['employees.delete']
  const EMPLOYEE = { id: EMPLOYEE_ID, first_name: 'Anna', last_name: 'Andersson', is_active: true }

  it('takes the employee id', () => {
    expect(accepts(op, valid)).toBe(true)
    expect(accepts(op, { employee_id: 'anna' })).toBe(false)
    expect(accepts(op, {})).toBe(false)
  })

  it('dry run: names the employee and says whether anything would change, through the service with dryRun true', async () => {
    svc.softDeleteEmployee.mockResolvedValue({ ok: true, data: { committed: false, employee: EMPLOYEE } })

    const preview = expectPreview(await run(op, valid, true))

    expect(svc.softDeleteEmployee).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY_ID,
      employeeId: EMPLOYEE_ID,
      dryRun: true,
    })
    expect(preview).toMatchObject({
      employee_id: EMPLOYEE_ID,
      first_name: 'Anna',
      last_name: 'Andersson',
      currently_active: true,
      would_deactivate: true,
    })

    svc.softDeleteEmployee.mockResolvedValue({
      ok: true,
      data: { committed: false, employee: { ...EMPLOYEE, is_active: false } },
    })
    expect(expectPreview(await run(op, valid, true))).toMatchObject({ currently_active: false, would_deactivate: false })
  })

  it('commit: the employee is inactive; changed says whether anything was written', async () => {
    svc.softDeleteEmployee.mockResolvedValue({ ok: true, data: { committed: true, employee: EMPLOYEE, changed: true } })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      is_active: false,
      changed: true,
    })

    svc.softDeleteEmployee.mockResolvedValue({
      ok: true,
      data: { committed: true, employee: { ...EMPLOYEE, is_active: false }, changed: false },
    })
    expect(op.output.parse(expectData(await run(op, valid)))).toEqual({
      employee_id: EMPLOYEE_ID,
      is_active: false,
      changed: false,
    })
  })

  it('passes EMPLOYEE_NOT_FOUND through, and a database failure as the raw error for MCP to classify', async () => {
    svc.softDeleteEmployee.mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })
    expect(expectFailure(await run(op, valid, true))).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })

    const cause = { code: '57014', message: 'canceling statement due to statement timeout' }
    svc.softDeleteEmployee.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', cause })
    const failure = expectFailure(await run(op, valid))
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', error: cause })
    expect(() => throwOutcomeFailure(failure)).toThrow(expect.objectContaining({ code: '57014' }))
  })

  it('titles the approval as what happens: a deactivation', () => {
    expect(op.mcp!.stage!.title(op.input.parse(valid) as Record<string, unknown>)).toBe('Inaktivera anställd')
  })
})
