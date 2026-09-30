/**
 * Employee payroll setup over MCP: the standing data a salary run reads for
 * each employee, and removing an employee who has left.
 *
 *   employees.worked-days.*       hours per date (tidrapport) for hourly staff and OB
 *   employees.benefits.*          förmåner: a standing monthly förmånsvärde per row
 *   employees.recurring-lines.*   standing payslip deductions (bruttolöneavdrag, fackavgift)
 *   employees.delete              soft delete: is_active=false, the row is kept
 *
 * MCP only. The v1 doors are the hand-written routes under
 * /api/v1/companies/{companyId}/employees/{id}/..., which answer bare arrays
 * for lists, read filters from the query string and the ids from the path;
 * binding these operations to those paths would change their public
 * contract (vat-filings.ts made the same choice). Both doors run the same
 * services, dry runs included (lib/salary/worked-days.ts,
 * employee-benefits.ts, employee-recurring-lines.ts, employee-soft-delete.ts),
 * validate with the same request schemas, and share operation ids, scopes
 * and risks with the v1 endpoints.
 *
 * Nothing here computes an amount. A benefit stores the monthly förmånsvärde
 * the caller supplies, bilförmån included; the bike schablon and the öre
 * rounding of recurring amounts are the services' own rules.
 */
import { z } from 'zod'
import {
  CreateEmployeeBenefitSchema,
  CreateEmployeeRecurringLineSchema,
  RecurringLineItemTypeSchema,
  UpdateEmployeeBenefitSchema,
  UpdateEmployeeRecurringLineSchema,
} from '@/lib/api/schemas'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import {
  EmployeeBenefitResourceSchema,
  createEmployeeBenefit,
  deleteEmployeeBenefit,
  listEmployeeBenefits,
  toEmployeeBenefitPreviewResource,
  toEmployeeBenefitResource,
  updateEmployeeBenefit,
} from '@/lib/salary/employee-benefits'
import {
  createEmployeeRecurringLine,
  deleteEmployeeRecurringLine,
  listEmployeeRecurringLines,
  updateEmployeeRecurringLine,
  type EmployeeRecurringLinePreview,
  type EmployeeRecurringLineRow,
} from '@/lib/salary/employee-recurring-lines'
import { softDeleteEmployee } from '@/lib/salary/employee-soft-delete'
import {
  ApiWorkedDaysRangeSchema,
  ApiWorkedDaysUpsertSchema,
  WORKED_DAYS_RANGE_MAX_DAYS,
  deleteWorkedDaysRange,
  listWorkedDays,
  upsertWorkedDays,
  workedDaysRangeSpan,
  type WorkedDayPreview,
  type WorkedDayRow,
} from '@/lib/salary/worked-days'
import { defineOperation, type OperationOutcome } from './types'

const EMPLOYEE_ID = z.string().uuid().describe('The employee id (employees.id), from gnubok_list_employees.')
const BENEFIT_ID = z
  .string()
  .uuid()
  .describe('The benefit id (employee_benefit_id), from gnubok_list_employee_benefits.')
const RECURRING_LINE_ID = z
  .string()
  .uuid()
  .describe('The recurring line id (employee_recurring_line_id), from gnubok_list_employee_recurring_lines.')

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EMPLOYEE_EXAMPLE_ID = 'emp_a8f1…'

// ---------------------------------------------------------------------------
// Service failures
// ---------------------------------------------------------------------------

type OperationFailure = Extract<OperationOutcome<unknown>, { ok: false }>

/**
 * A service failure as an operation outcome, code and details unchanged.
 * MCP shows an error's message, not its details, so a message the service
 * wrote for the caller ({ field, message }, or the first of { issues })
 * becomes the message, and a register lock names the run that holds the
 * dates. Raw database text (details without a field) is never shown.
 */
function failed(result: { code: string; details?: Record<string, unknown> }, code = result.code): OperationFailure {
  const messageSv = failureMessage(code, result.details)
  return {
    ok: false,
    code,
    ...(result.details ? { details: result.details } : {}),
    ...(messageSv ? { messageSv } : {}),
  }
}

function failureMessage(code: string, details: Record<string, unknown> | undefined): string | undefined {
  if (!details) return undefined
  if (code === 'SALARY_REGISTER_DATES_LOCKED_BY_RUN') return registerLockMessage(details)
  if (code !== 'VALIDATION_ERROR') return undefined
  const issue = (Array.isArray(details.issues) ? details.issues[0] : details) as Record<string, unknown> | undefined
  if (typeof issue?.field === 'string' && typeof issue.message === 'string') return `${issue.field}: ${issue.message}`
  return undefined
}

function registerLockMessage(details: Record<string, unknown>): string | undefined {
  if (typeof details.salary_run_id !== 'string') return undefined
  const dates = Array.isArray(details.locked_dates) ? (details.locked_dates as string[]) : []
  const span = dates.length > 1 ? `${dates[0]} till ${dates[dates.length - 1]}` : (dates[0] ?? '')
  const period = `${details.period_year}-${String(details.period_month).padStart(2, '0')}`
  const base = getErrorEntry('SALARY_REGISTER_DATES_LOCKED_BY_RUN')?.message_sv ?? ''
  return `${base} Lönekörning ${details.salary_run_id} (${period}, ${String(details.status)}) läser ${dates.length} av datumen: ${span}.`
}

// ---------------------------------------------------------------------------
// Worked days (tidrapport)
// ---------------------------------------------------------------------------

/**
 * Codes the worked-days service answers that have no registry entry of their
 * own, mapped as the v1 route maps them. The 24h cap is a trigger shared with
 * absence, so its registered code is ABSENCE_HOURS_CONFLICT.
 */
const WORKED_DAYS_REGISTRY_CODE: Record<string, string> = {
  WORKED_HOURS_CONFLICT: 'ABSENCE_HOURS_CONFLICT',
  WORKED_DAYS_RANGE_TOO_LARGE: 'VALIDATION_ERROR',
}

function workedDaysFailed(result: { code: string; details?: Record<string, unknown> }): OperationFailure {
  const failure = failed(result, WORKED_DAYS_REGISTRY_CODE[result.code] ?? result.code)
  if (result.code !== 'WORKED_HOURS_CONFLICT') return failure
  // The registry sentence speaks of absence only; worked hours count too.
  return { ...failure, messageSv: 'Arbetade timmar och frånvaro får tillsammans vara högst 24 timmar per dag.' }
}

const WorkedDay = z.object({
  salary_worked_day_id: z.string().uuid(),
  work_date: z.string(),
  hours: z.number(),
  start_time: z.string().nullable().describe('Shift start (HH:MM:SS); null prices the day as 08:00-17:00.'),
  end_time: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

function toWorkedDay(row: WorkedDayRow): z.infer<typeof WorkedDay> {
  return {
    salary_worked_day_id: row.id,
    work_date: row.work_date,
    // numeric columns can arrive as strings from PostgREST
    hours: Number(row.hours),
    start_time: row.start_time,
    end_time: row.end_time,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const WORKED_DAY_EXAMPLE = {
  salary_worked_day_id: 'wd_91d2…',
  work_date: '2026-03-02',
  hours: 8,
  start_time: '22:00:00',
  end_time: '06:00:00',
  notes: null,
  created_at: '2026-03-05T08:00:00Z',
  updated_at: '2026-03-05T08:00:00Z',
}

const LOCKED_BY_RUN_PITFALL =
  'Dates inside the deviation window of a salary run that is calculated (review), approved, paid or booked are locked: SALARY_REGISTER_DATES_LOCKED_BY_RUN names the run and nothing is written, dry runs included. Revert that run to draft first (gnubok_unapprove_salary_run for an approved run, then gnubok_revert_salary_run); a paid or booked run needs a correction run. Draft runs never lock.'

function dateSpan(from: string, to: string): string {
  return from === to ? from : `${from} till ${to}`
}

export const employeesWorkedDaysList = defineOperation({
  id: 'employees.worked-days.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List worked days (hours per date) for an employee in a date range.',
    description:
      'Returns the per-day worked-hours rows (tidrapport) between from and to (inclusive, at most 92 days): hours, the optional shift window (start_time/end_time) and notes. The bounded range is the page: there is no cursor.',
    useWhen:
      'You need what is registered for an hourly employee before running payroll, to reconcile with an external time-tracking system, or to verify the hours the salary engine will pick up.',
    doNotUseFor:
      'Absence (sick, vab, parental leave): gnubok_list_absence. The derived pay (hourly gross, OB lines): it is on the salary run after gnubok_calculate_salary_run (gnubok_get_salary_run).',
    pitfalls: [
      'A range over 92 days is refused with VALIDATION_ERROR: iterate quarters instead.',
      "gnubok_calculate_salary_run reads these rows by the run's deviation window (deviation_period_start..deviation_period_end), not the pay month: check the run's window before calculating.",
      'One row per date: two shifts on the same day are ONE row with the combined hours (and the shift window of the OB-relevant one).',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID, from: '2026-03-01', to: '2026-03-31' },
      response: {
        data: { employee_id: EMPLOYEE_EXAMPLE_ID, from: '2026-03-01', to: '2026-03-31', worked_days: [WORKED_DAY_EXAMPLE] },
        meta: META,
      },
    },
  },
  input: ApiWorkedDaysRangeSchema.extend({ employee_id: EMPLOYEE_ID }).superRefine((range, ctx) => {
    // The same cap as the v1 GET: the bounded range is the page.
    if (range.from > range.to) return
    const span = workedDaysRangeSpan(range.from, range.to)
    if (span === null || span > WORKED_DAYS_RANGE_MAX_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `Range may span at most ${WORKED_DAYS_RANGE_MAX_DAYS} days.`,
      })
    }
  }),
  output: z.object({
    employee_id: z.string().uuid(),
    from: z.string(),
    to: z.string(),
    worked_days: z.array(WorkedDay),
  }),
  errorCodes: ['EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_list_worked_days',
    title: 'List Worked Days',
    description:
      'Worked hours per date (tidrapport) registered for an hourly employee over at most 92 days, with shift start and end times for OB. These rows are what a salary run sums into hourly pay when it is calculated.',
    keywords: ['arbetade timmar', 'tidrapport', 'timmar', 'timanställd', 'timlön', 'arbetstid', 'ob', 'skift'],
  },
  run: async (ctx, { employee_id, from, to }) => {
    const result = await listWorkedDays(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      from,
      to,
    })
    if (!result.ok) return workedDaysFailed(result)
    return { ok: true, data: { employee_id, from, to, worked_days: result.data.map(toWorkedDay) } }
  },
})

export const employeesWorkedDaysUpsert = defineOperation({
  id: 'employees.worked-days.upsert',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Register worked hours per day for an employee (bulk upsert).',
    description:
      'Upserts 1..92 explicit per-day rows on the natural key (employee, work_date) in one atomic statement. A date already registered is overwritten with the new hours, shift window and notes (an omitted optional field is cleared, not carried forward). Replaying the same days converges on the same rows. Each work_date may appear once per call. The dry run (the staging preview) runs every check the write runs, the register lock included, and lists the days as they would be stored.',
    useWhen:
      "An external time-tracking or payroll system pushes an hourly employee's tidrapport for a period, including shift start and end times for OB (obekväm arbetstid) premiums, before the salary run is calculated.",
    doNotUseFor:
      'Absence: gnubok_register_absence. Monthly-salaried staff without OB rules: their gross comes from the employee record, not from this register.',
    pitfalls: [
      "gnubok_calculate_salary_run reads these rows by the run's deviation window (deviation_period_start..deviation_period_end), not the pay month: register the hours on the dates they were actually worked.",
      "For an hourly employee the run's gross is hourly_rate x the sum of these hours, not a monthly salary.",
      'start_time/end_time feed the OB (shift premium) rules: a row without them is priced as an assumed 08:00-17:00 day, so a night or weekend shift earns no premium. Times are HH:MM or HH:MM:SS; end_time before start_time means the shift crosses midnight.',
      'Worked hours plus absence hours on one date may not exceed 24 (a database rule shared with absence): the whole call is refused with ABSENCE_HOURS_CONFLICT and nothing is written.',
      LOCKED_BY_RUN_PITFALL,
      'Registering hours does not recalculate a draft salary run: call gnubok_calculate_salary_run afterwards.',
    ],
    example: {
      request: {
        employee_id: EMPLOYEE_EXAMPLE_ID,
        days: [
          { work_date: '2026-03-02', hours: 8, start_time: '22:00', end_time: '06:00' },
          { work_date: '2026-03-03', hours: 4, notes: 'Halvdag' },
        ],
      },
      response: {
        data: { employee_id: EMPLOYEE_EXAMPLE_ID, count: 2, worked_days: [WORKED_DAY_EXAMPLE] },
        meta: META,
      },
    },
  },
  input: ApiWorkedDaysUpsertSchema.extend({ employee_id: EMPLOYEE_ID }),
  output: z.object({
    employee_id: z.string().uuid(),
    count: z.number().int(),
    worked_days: z.array(WorkedDay),
  }),
  errorCodes: [
    'EMPLOYEE_NOT_FOUND',
    'VALIDATION_ERROR',
    'ABSENCE_HOURS_CONFLICT',
    'SALARY_REGISTER_DATES_LOCKED_BY_RUN',
  ],
  mcp: {
    name: 'gnubok_set_worked_days',
    title: 'Set Worked Days',
    description:
      'Stage registering worked hours per date for an hourly employee (1-92 days, optional shift start and end for OB). A date already registered is overwritten. Dates a calculated, approved, paid or booked salary run has read are refused. Recalculate the draft run afterwards.',
    keywords: ['registrera timmar', 'arbetade timmar', 'tidrapport', 'timanställd', 'timlön', 'ob-tillägg', 'skift', 'arbetstid'],
    stage: {
      pendingType: 'set_worked_days',
      title: (input) => {
        const dates = (input.days as Array<{ work_date: string }>).map((day) => day.work_date).sort()
        const count = dates.length === 1 ? '1 dag' : `${dates.length} dagar`
        return `Registrera arbetade timmar (${count}, ${dateSpan(dates[0], dates[dates.length - 1])})`
      },
    },
  },
  run: async (ctx, { employee_id, days }, { dryRun }) => {
    const result = await upsertWorkedDays(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      days: days.map((day) => ({
        work_date: day.work_date,
        hours: day.hours,
        start_time: day.start_time ?? null,
        end_time: day.end_time ?? null,
        notes: day.notes ?? null,
      })),
      dryRun,
    })
    if (!result.ok) return workedDaysFailed(result)
    if (dryRun) {
      const preview = result.data.days as WorkedDayPreview[]
      const dates = preview.map((day) => day.work_date).sort()
      return {
        ok: true,
        dryRun: true,
        preview: {
          employee_id,
          count: result.data.count,
          from: dates[0] ?? null,
          to: dates[dates.length - 1] ?? null,
          days: preview,
          note: 'A date already registered is overwritten; an omitted start_time, end_time or notes clears the stored value.',
        },
      }
    }
    return {
      ok: true,
      data: {
        employee_id,
        count: result.data.count,
        worked_days: (result.data.days as WorkedDayRow[]).map(toWorkedDay),
      },
    }
  },
})

export const employeesWorkedDaysDelete = defineOperation({
  id: 'employees.worked-days.delete',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete worked days for an employee in a date range.',
    description:
      'Deletes the per-day worked-hours rows between from and to (inclusive); one day is from = to. Answers deleted_count so the caller can verify how many rows went. The dry run (the staging preview) counts the rows that would be deleted and checks the register lock.',
    useWhen:
      'Hours were pushed for the wrong employee or the wrong dates, or a time-tracking re-sync needs a clean period before the days are registered again.',
    doNotUseFor:
      'Correcting the hours of a day: register the day again with gnubok_set_worked_days, which overwrites it. Rows a calculated, approved, paid or booked run has already read: the delete is refused.',
    pitfalls: [
      'deleted_count 0 means nothing matched: not an error.',
      LOCKED_BY_RUN_PITFALL,
      'Hours a draft run has already summed stay in the run until gnubok_calculate_salary_run is called again.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID, from: '2026-03-02', to: '2026-03-03' },
      response: {
        data: { employee_id: EMPLOYEE_EXAMPLE_ID, from: '2026-03-02', to: '2026-03-03', deleted_count: 2 },
        meta: META,
      },
    },
  },
  input: ApiWorkedDaysRangeSchema.extend({ employee_id: EMPLOYEE_ID }),
  output: z.object({
    employee_id: z.string().uuid(),
    from: z.string(),
    to: z.string(),
    deleted_count: z.number().int(),
  }),
  errorCodes: ['EMPLOYEE_NOT_FOUND', 'SALARY_REGISTER_DATES_LOCKED_BY_RUN'],
  mcp: {
    name: 'gnubok_delete_worked_days',
    title: 'Delete Worked Days',
    description:
      'Stage removing the worked hours registered for an employee in a date range (from = to for one day). Dates a calculated, approved, paid or booked salary run has read are refused. The preview counts the rows that would go.',
    keywords: ['ta bort timmar', 'radera tidrapport', 'arbetade timmar', 'tidrapport', 'timanställd'],
    stage: {
      pendingType: 'delete_worked_days',
      title: (input) => `Ta bort arbetade timmar ${dateSpan(String(input.from), String(input.to))}`,
    },
  },
  run: async (ctx, { employee_id, from, to }, { dryRun }) => {
    const result = await deleteWorkedDaysRange(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      from,
      to,
      dryRun,
    })
    if (!result.ok) return workedDaysFailed(result)
    if (dryRun) {
      return { ok: true, dryRun: true, preview: { employee_id, from, to, would_delete_count: result.data.deleted_count } }
    }
    return { ok: true, data: { employee_id, from, to, deleted_count: result.data.deleted_count } }
  },
})

// ---------------------------------------------------------------------------
// Benefits (förmåner)
// ---------------------------------------------------------------------------

const BENEFIT_EXAMPLE = {
  employee_benefit_id: 'ben_4f2a…',
  benefit_type: 'car',
  description: 'Bilförmån Volvo XC40',
  monthly_value: 4275,
  annual_market_value: null,
  valid_from: '2026-01-01',
  valid_to: null,
  is_active: true,
  metadata: {},
  created_at: '2026-01-05T09:12:00Z',
  updated_at: '2026-01-05T09:12:00Z',
}

const BENEFIT_PATCH_FIELDS = Object.keys(UpdateEmployeeBenefitSchema.shape)

const BENEFIT_KEPT_NOTE =
  'A benefit a payslip line already derives from is kept and switched off (is_active=false) instead of deleted.'

export const employeesBenefitsList = defineOperation({
  id: 'employees.benefits.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the benefits (förmåner) registered on an employee.',
    description:
      'Returns every benefit row on the employee, active and inactive, newest validity window first (valid_from, then created_at, descending). Optional active filter. No cursor: an employee carries a handful of rows.',
    useWhen:
      'You need to see which förmåner the salary engine will derive for an employee (bilförmån, kostförmån, cykelförmån, bostad, friskvård, annat), reconcile against an HR system, or find the employee_benefit_id to update or remove.',
    doNotUseFor:
      'The derived payslip line and its tax effect: it is on the salary run after gnubok_calculate_salary_run. Standing deductions (bruttolöneavdrag, fackavgift): gnubok_list_employee_recurring_lines.',
    pitfalls: [
      'The monthly förmånsvärde is added to the tax and arbetsgivaravgift basis when a run is calculated; it is never paid out.',
      'A run derives a row when is_active is true and valid_from <= payment_date <= valid_to (valid_to null = open-ended). Rows outside that window are listed here but derive nothing.',
      'annual_market_value is set for bike benefits only (read from the stored calculation inputs); other types carry null.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID },
      response: { data: { employee_id: EMPLOYEE_EXAMPLE_ID, benefits: [BENEFIT_EXAMPLE] }, meta: META },
    },
  },
  input: z.object({
    employee_id: EMPLOYEE_ID,
    active: z.boolean().optional().describe('true: only active rows; false: only inactive rows. Omit for both.'),
  }),
  output: z.object({
    employee_id: z.string().uuid(),
    benefits: z.array(EmployeeBenefitResourceSchema),
  }),
  errorCodes: ['EMPLOYEE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_list_employee_benefits',
    title: 'List Employee Benefits',
    description:
      'The förmåner (car, meals, housing, bike, wellness, other) registered on an employee, active and inactive, with the monthly förmånsvärde a salary run adds to the tax and avgift basis while the row is valid.',
    keywords: ['förmåner', 'förmån', 'bilförmån', 'kostförmån', 'cykelförmån', 'bostadsförmån', 'friskvård', 'förmånsvärde'],
  },
  run: async (ctx, { employee_id, active }) => {
    const result = await listEmployeeBenefits(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      active,
    })
    if (!result.ok) return failed(result)
    return { ok: true, data: { employee_id, benefits: result.data.map(toEmployeeBenefitResource) } }
  },
})

export const employeesBenefitsCreate = defineOperation({
  id: 'employees.benefits.create',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Register a benefit (förmån) on an employee.',
    description:
      'Creates a standing monthly förmånsvärde row. benefit_type is one of bike, car, meals, housing, wellness, other. Every type except bike takes monthly_value: the schablon value you already know. bike takes annual_market_value and the server derives monthly_value = max(0, annual_market_value - 3000) / 12 (Skatteverket schablon, 3 000 kr a year tax-free), storing the inputs in metadata. The dry run (the staging preview) is the row that would be inserted, derived values included.',
    useWhen:
      '"Anna gets a company car from January": register the schablon value once and every run inside the validity window derives the line. Also when moving an employee register over from another payroll system.',
    doNotUseFor:
      "Computing a bilförmån from the car (nybilspris, miljöbil, fordonsskatt): do that with Skatteverket's calculator and send the result. Standing deductions such as a bruttolöneavdrag for the same car: gnubok_add_employee_recurring_line. A one-off taxable addition on one payslip: a line on that salary run.",
    pitfalls: [
      'The förmånsvärde is added to the tax and arbetsgivaravgift basis when a run is calculated: skatteavdrag and avgifter go up, nothing is paid out. Registering a benefit does not recalculate an open run; call gnubok_calculate_salary_run afterwards.',
      'car (bilförmån) is the monthly schablon value you computed (Skatteverket, including miljöbil and mileage reductions); nothing computes it from the car.',
      'bike takes annual_market_value, not monthly_value: the server derives the monthly value with the 3 000 kr a year tax-free allowance. A monthly_value sent next to annual_market_value on a bike row is ignored.',
      'valid_from and valid_to gate which runs pick the row up: a run derives the line when valid_from <= payment_date <= valid_to (valid_to omitted = open-ended). Both dates are inclusive; valid_to before valid_from is refused.',
    ],
    example: {
      request: {
        employee_id: EMPLOYEE_EXAMPLE_ID,
        benefit_type: 'bike',
        description: 'Cykelförmån',
        annual_market_value: 15000,
        valid_from: '2026-03-01',
      },
      response: {
        data: {
          employee_id: EMPLOYEE_EXAMPLE_ID,
          employee_benefit_id: 'ben_91d2…',
          benefit_type: 'bike',
          description: 'Cykelförmån',
          monthly_value: 1000,
          annual_market_value: 15000,
          valid_from: '2026-03-01',
          valid_to: null,
          is_active: true,
          metadata: { annual_market_value: 15000, annual_taxable: 12000, tax_free_portion: 3000 },
          created_at: '2026-02-20T10:00:00Z',
          updated_at: '2026-02-20T10:00:00Z',
        },
        meta: META,
      },
    },
  },
  input: CreateEmployeeBenefitSchema.extend({ employee_id: EMPLOYEE_ID }),
  output: EmployeeBenefitResourceSchema.extend({ employee_id: z.string().uuid() }),
  errorCodes: ['EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_add_employee_benefit',
    title: 'Add Employee Benefit',
    description:
      "Stage registering a förmån on an employee: the monthly förmånsvärde you supply (e.g. bilförmån from Skatteverket's calculator; bike takes annual_market_value). Every salary run whose payment date is within valid_from..valid_to adds it to the tax basis.",
    keywords: ['lägg till förmån', 'ny förmån', 'bilförmån', 'förmånsbil', 'kostförmån', 'cykelförmån', 'bostadsförmån', 'friskvård', 'förmånsvärde'],
    stage: {
      pendingType: 'add_employee_benefit',
      title: (input) => `Lägg till förmån: ${String(input.description)}`,
    },
  },
  run: async (ctx, { employee_id, ...input }, { dryRun }) => {
    const result = await createEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      userId: ctx.userId,
      input,
      dryRun,
    })
    if (!result.ok) return failed(result)
    if (!result.data.committed) {
      return {
        ok: true,
        dryRun: true,
        preview: { employee_id, ...toEmployeeBenefitPreviewResource(result.data.preview) },
      }
    }
    return { ok: true, created: true, data: { employee_id, ...toEmployeeBenefitResource(result.data.row) } }
  },
})

export const employeesBenefitsUpdate = defineOperation({
  id: 'employees.benefits.update',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Partially update a benefit (förmån) on an employee.',
    description:
      'Changes the supplied fields: description, monthly_value, valid_from, valid_to (null clears it), is_active, metadata, and for bike rows annual_market_value (the server derives monthly_value again). benefit_type cannot change: remove the benefit and register a new one. The dry run (the staging preview) is the merged row.',
    useWhen:
      'The förmånsvärde changes (a new schablon for the year, a new bike price), the benefit ends (set valid_to), or it should pause without losing the row (is_active=false).',
    doNotUseFor:
      'Changing the benefit kind: remove it and register a new one. Changing the derived line on one salary run only: that line belongs to the run, the register stays as it is.',
    pitfalls: [
      'valid_from and valid_to are checked against the stored row merged with the change: a valid_to before the stored valid_from is refused (VALIDATION_ERROR on valid_to).',
      'annual_market_value is accepted on bike rows only and overrides any monthly_value in the same call.',
      'A change does not recalculate an open run: call gnubok_calculate_salary_run afterwards.',
      'To stop a benefit a calculated run already used, set is_active=false or valid_to; the derived line stays on a draft run until it is recalculated.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID, employee_benefit_id: 'ben_4f2a…', valid_to: '2026-06-30' },
      response: {
        data: {
          employee_id: EMPLOYEE_EXAMPLE_ID,
          ...BENEFIT_EXAMPLE,
          valid_to: '2026-06-30',
          updated_at: '2026-06-02T14:40:00Z',
        },
        meta: META,
      },
    },
  },
  input: UpdateEmployeeBenefitSchema.extend({
    employee_id: EMPLOYEE_ID,
    employee_benefit_id: BENEFIT_ID,
  }).refine((input) => BENEFIT_PATCH_FIELDS.some((field) => (input as Record<string, unknown>)[field] !== undefined), {
    message: 'At least one field must be supplied for update.',
  }),
  output: EmployeeBenefitResourceSchema.extend({ employee_id: z.string().uuid() }),
  errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_update_employee_benefit',
    title: 'Update Employee Benefit',
    description:
      "Stage a change to an employee's förmån: monthly value, validity (valid_to ends it), is_active or description. The benefit type cannot change. A draft salary run keeps the old line until it is recalculated.",
    keywords: ['ändra förmån', 'förmånsvärde', 'avsluta förmån', 'pausa förmån', 'bilförmån', 'cykelförmån'],
    stage: {
      pendingType: 'update_employee_benefit',
      title: () => 'Ändra förmån',
    },
  },
  run: async (ctx, { employee_id, employee_benefit_id, ...patch }, { dryRun }) => {
    const result = await updateEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      benefitId: employee_benefit_id,
      patch,
      dryRun,
    })
    if (!result.ok) return failed(result)
    if (!result.data.committed) {
      return { ok: true, dryRun: true, preview: { employee_id, ...toEmployeeBenefitResource(result.data.preview) } }
    }
    return { ok: true, data: { employee_id, ...toEmployeeBenefitResource(result.data.row) } }
  },
})

export const employeesBenefitsDelete = defineOperation({
  id: 'employees.benefits.delete',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Remove a benefit (förmån) from an employee.',
    description:
      'Removes the benefit, the same operation the dashboard performs. A row no payslip line derives from is deleted; a row a calculated run already derived a line from is kept and switched off (is_active=false), so the chain from a possibly booked verifikat back to its förmån stays intact (BFL 5 kap 6-7 §). Answers deleted and deactivated. The dry run (the staging preview) is the row that would be removed.',
    useWhen:
      'A benefit was registered by mistake, or it has ended and no longer needs to be listed as active.',
    doNotUseFor:
      'Ending a benefit on a date while it stays active until then: gnubok_update_employee_benefit with valid_to. Removing the derived line from one salary run: edit that run.',
    pitfalls: [
      'deleted=false with deactivated=true is a success: a payslip line already derives from the benefit, so it is kept, switched off, and never derived again.',
      'Removing or deactivating a benefit does not recalculate an open run: the derived line stays on a draft run until gnubok_calculate_salary_run drops it. A booked run is never changed.',
      'A benefit id that is not on this employee answers NOT_FOUND.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID, employee_benefit_id: 'ben_9c2e…' },
      response: {
        data: { employee_id: EMPLOYEE_EXAMPLE_ID, employee_benefit_id: 'ben_9c2e…', deleted: true, deactivated: false },
        meta: META,
      },
    },
  },
  input: z.object({ employee_id: EMPLOYEE_ID, employee_benefit_id: BENEFIT_ID }),
  output: z.object({
    employee_id: z.string().uuid(),
    employee_benefit_id: z.string().uuid(),
    deleted: z.boolean(),
    deactivated: z.boolean().describe('True when a payslip line derives from the benefit: kept and switched off instead.'),
  }),
  errorCodes: ['NOT_FOUND'],
  mcp: {
    name: 'gnubok_delete_employee_benefit',
    title: 'Delete Employee Benefit',
    description:
      'Stage removing a förmån from an employee. A benefit a calculated salary run already derived a payslip line from is kept and deactivated instead, so the line keeps its source. To end it on a date, update valid_to instead.',
    keywords: ['ta bort förmån', 'radera förmån', 'avsluta förmån', 'bilförmån', 'förmån'],
    stage: {
      pendingType: 'delete_employee_benefit',
      title: () => 'Ta bort förmån',
    },
  },
  run: async (ctx, { employee_id, employee_benefit_id }, { dryRun }) => {
    const result = await deleteEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      benefitId: employee_benefit_id,
      dryRun,
    })
    if (!result.ok) return failed(result)
    if (!result.data.committed) {
      return {
        ok: true,
        dryRun: true,
        preview: { employee_id, ...toEmployeeBenefitResource(result.data.preview), note: BENEFIT_KEPT_NOTE },
      }
    }
    const { deleted, deactivated } = result.data
    // A filtered delete of a row that vanished since the lookup matches
    // nothing: the v1 route answers that with 404 too.
    if (!deleted && !deactivated) return { ok: false, code: 'NOT_FOUND', details: { resource: 'employee_benefit' } }
    return { ok: true, data: { employee_id, employee_benefit_id, deleted, deactivated: deactivated === true } }
  },
})

// ---------------------------------------------------------------------------
// Recurring payslip lines (återkommande lönerader)
// ---------------------------------------------------------------------------

const RecurringLineFields = z.object({
  item_type: RecurringLineItemTypeSchema,
  description: z.string(),
  amount: z.number().describe('SEK, negative: every supported item type is a deduction.'),
  account_number: z
    .string()
    .nullable()
    .describe('BAS account for the derived payslip row, as a string; null lets the engine map the item type.'),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  is_active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
})

const RecurringLine = RecurringLineFields.extend({
  employee_recurring_line_id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

function toRecurringLineFields(
  row: EmployeeRecurringLineRow | EmployeeRecurringLinePreview,
): z.infer<typeof RecurringLineFields> {
  return {
    item_type: row.item_type,
    description: row.description,
    amount: row.amount,
    account_number: row.account_number,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
    metadata: row.metadata,
  }
}

function toRecurringLine(row: EmployeeRecurringLineRow): z.infer<typeof RecurringLine> {
  return {
    employee_recurring_line_id: row.id,
    ...toRecurringLineFields(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const RECURRING_LINE_EXAMPLE = {
  employee_recurring_line_id: 'erl_5b1c…',
  item_type: 'gross_deduction_other',
  description: 'Förmånscykel bruttolöneavdrag',
  amount: -670.17,
  account_number: null,
  valid_from: '2026-01-01',
  valid_to: null,
  is_active: true,
  metadata: {},
  created_at: '2026-01-02T09:00:00Z',
  updated_at: '2026-01-02T09:00:00Z',
}

const RECURRING_LINE_PATCH_FIELDS = Object.keys(UpdateEmployeeRecurringLineSchema.shape)

const RECURRING_DERIVED_PITFALL =
  'Lines are derived again on every calculation of a run whose payment_date is within valid_from..valid_to (valid_to null = open-ended): a hand edit to a derived payslip row is overwritten by the next gnubok_calculate_salary_run.'
const RECURRING_SIGN_PITFALL =
  'Every supported item_type is a deduction, so the amount is negative (e.g. -670.17 for a benefit bike bruttolöneavdrag); the wrong sign is refused with VALIDATION_ERROR on amount.'
const RECURRING_ACCOUNT_PITFALL =
  'account_number overrides the default BAS account for the derived payslip row; null lets the engine map the item type.'

export const employeesRecurringLinesList = defineOperation({
  id: 'employees.recurring-lines.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List recurring payslip lines for an employee.',
    description:
      "Returns the employee's standing monthly payslip rows (gross and net deductions such as a benefit bike bruttolöneavdrag, a union fee, or a net deduction for a benefit the employee pays for), newest valid_from first. Active and deactivated lines unless active filters them.",
    useWhen:
      'You need to see what the salary engine derives for an employee every month, to reconcile with an HR system, or to find the employee_recurring_line_id to update or delete.',
    doNotUseFor:
      'The derived payslip rows of one run: they are on the salary run after gnubok_calculate_salary_run. Taxable benefits in kind (bilförmån, kostförmån): gnubok_list_employee_benefits.',
    pitfalls: [
      RECURRING_DERIVED_PITFALL,
      RECURRING_SIGN_PITFALL,
      RECURRING_ACCOUNT_PITFALL,
      'Deactivated lines (is_active=false) are listed too: a line a run has derived from cannot be deleted, only deactivated, so history keeps it.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID },
      response: { data: { employee_id: EMPLOYEE_EXAMPLE_ID, recurring_lines: [RECURRING_LINE_EXAMPLE] }, meta: META },
    },
  },
  input: z.object({
    employee_id: EMPLOYEE_ID,
    active: z.boolean().optional().describe('true: active lines only; false: deactivated lines only. Omit for every line.'),
  }),
  output: z.object({
    employee_id: z.string().uuid(),
    recurring_lines: z.array(RecurringLine),
  }),
  errorCodes: ['EMPLOYEE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_list_employee_recurring_lines',
    title: 'List Recurring Payslip Lines',
    description:
      "An employee's recurring payslip lines (bruttolöneavdrag, fackavgift, nettolöneavdrag): standing monthly deductions every salary run derives while the line is valid. Active and deactivated lines.",
    keywords: ['återkommande lönerad', 'löneavdrag', 'bruttolöneavdrag', 'nettolöneavdrag', 'fackavgift', 'förmånscykel', 'löneväxling'],
  },
  run: async (ctx, { employee_id, active }) => {
    const result = await listEmployeeRecurringLines(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      isActive: active,
    })
    if (!result.ok) return failed(result)
    return { ok: true, data: { employee_id, recurring_lines: result.data.map(toRecurringLine) } }
  },
})

export const employeesRecurringLinesCreate = defineOperation({
  id: 'employees.recurring-lines.create',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Create a recurring payslip line for an employee.',
    description:
      'Adds a standing monthly payslip row. From the next calculation on, every salary run whose payment_date is within valid_from..valid_to derives a payslip line from it, with its flags (taxable, avgift basis, gross or net deduction) fixed by item_type. Amounts are kept to whole öre. The dry run (the staging preview) is the row that would be inserted.',
    useWhen:
      'An employee starts a benefit bike bruttolöneavdrag, a union fee, a monthly net deduction for a benefit they pay for, or any other deduction that repeats every month until further notice.',
    doNotUseFor:
      'A one-off deduction on a single payslip: a line on that salary run. Additions (a monthly allowance paid in cash): not a recurring line, add them per run. Taxable benefits in kind: gnubok_add_employee_benefit.',
    pitfalls: [
      RECURRING_SIGN_PITFALL,
      'valid_to must be on or after valid_from (inclusive); omit it for an open-ended line.',
      RECURRING_ACCOUNT_PITFALL,
      'Creating a line does not recalculate an open salary run: call gnubok_calculate_salary_run afterwards.',
    ],
    example: {
      request: {
        employee_id: EMPLOYEE_EXAMPLE_ID,
        item_type: 'gross_deduction_other',
        description: 'Förmånscykel bruttolöneavdrag',
        amount: -670.17,
        valid_from: '2026-01-01',
      },
      response: { data: { employee_id: EMPLOYEE_EXAMPLE_ID, ...RECURRING_LINE_EXAMPLE }, meta: META },
    },
  },
  input: CreateEmployeeRecurringLineSchema.extend({ employee_id: EMPLOYEE_ID }),
  output: RecurringLine.extend({ employee_id: z.string().uuid() }),
  errorCodes: ['EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_add_employee_recurring_line',
    title: 'Add Recurring Payslip Line',
    description:
      'Stage a recurring payslip line for an employee: a monthly deduction (negative amount) such as a bike bruttolöneavdrag or a union fee, derived into every salary run whose payment date is within valid_from..valid_to.',
    keywords: ['återkommande avdrag', 'återkommande lönerad', 'bruttolöneavdrag', 'nettolöneavdrag', 'fackavgift', 'löneväxling', 'förmånscykel'],
    stage: {
      pendingType: 'add_employee_recurring_line',
      title: (input) => `Lägg till återkommande lönerad: ${String(input.description)}`,
    },
  },
  run: async (ctx, { employee_id, ...input }, { dryRun }) => {
    const result = await createEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      userId: ctx.userId,
      input,
      dryRun,
    })
    if (!result.ok) return failed(result)
    // A dry run answers the would-be row, which has no id yet.
    if (result.data.id === null) {
      return { ok: true, dryRun: true, preview: { employee_id, ...toRecurringLineFields(result.data) } }
    }
    return { ok: true, created: true, data: { employee_id, ...toRecurringLine(result.data) } }
  },
})

export const employeesRecurringLinesUpdate = defineOperation({
  id: 'employees.recurring-lines.update',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Update a recurring payslip line.',
    description:
      'Changes description, amount, account_number, valid_from, valid_to, is_active or metadata on a recurring line. The amount sign is checked against the stored item_type and the validity period against the stored dates merged with the change. item_type cannot change: delete the line and create a new one. The dry run (the staging preview) is the merged row.',
    useWhen:
      'The monthly deduction changed (a new bike lease amount), the line ends on a known date (set valid_to), or it should pause without losing history (is_active=false).',
    doNotUseFor:
      'Changing the kind of line (gross to net deduction): delete it and create a new one. Fixing one payslip only: edit the line on that salary run.',
    pitfalls: [
      RECURRING_DERIVED_PITFALL,
      RECURRING_SIGN_PITFALL,
      'A change that leaves valid_to before valid_from on the merged row is refused (VALIDATION_ERROR on valid_to); valid_to: null makes the line open-ended again.',
      'Runs already calculated keep their derived rows until they are recalculated; booked runs are never touched.',
    ],
    example: {
      request: {
        employee_id: EMPLOYEE_EXAMPLE_ID,
        employee_recurring_line_id: 'erl_5b1c…',
        amount: -700,
        valid_to: '2026-12-31',
      },
      response: {
        data: { employee_id: EMPLOYEE_EXAMPLE_ID, ...RECURRING_LINE_EXAMPLE, amount: -700, valid_to: '2026-12-31' },
        meta: META,
      },
    },
  },
  input: UpdateEmployeeRecurringLineSchema.extend({
    employee_id: EMPLOYEE_ID,
    employee_recurring_line_id: RECURRING_LINE_ID,
  }).refine(
    (input) => RECURRING_LINE_PATCH_FIELDS.some((field) => (input as Record<string, unknown>)[field] !== undefined),
    { message: 'At least one updatable field is required.' },
  ),
  output: RecurringLine.extend({ employee_id: z.string().uuid() }),
  errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'],
  mcp: {
    name: 'gnubok_update_employee_recurring_line',
    title: 'Update Recurring Payslip Line',
    description:
      'Stage a change to a recurring payslip line: amount (negative, a deduction), description, account, validity (valid_to ends it) or is_active. item_type cannot change. Recalculate a draft salary run afterwards.',
    keywords: ['ändra löneavdrag', 'ändra återkommande lönerad', 'bruttolöneavdrag', 'fackavgift', 'avsluta avdrag'],
    stage: {
      pendingType: 'update_employee_recurring_line',
      title: () => 'Ändra återkommande lönerad',
    },
  },
  run: async (ctx, { employee_id, employee_recurring_line_id, ...patch }, { dryRun }) => {
    const result = await updateEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      lineId: employee_recurring_line_id,
      patch,
      dryRun,
    })
    if (!result.ok) return failed(result)
    const line = { employee_id, ...toRecurringLine(result.data) }
    if (dryRun) return { ok: true, dryRun: true, preview: line }
    return { ok: true, data: line }
  },
})

export const employeesRecurringLinesDelete = defineOperation({
  id: 'employees.recurring-lines.delete',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete a recurring payslip line, or deactivate it if a run already used it.',
    description:
      'Removes the line when no salary run has derived a payslip row from it. Once a run has, the database refuses the delete and the line is deactivated instead (is_active=false): the payslip row keeps its provenance, the next calculation of a draft run drops the derived row, and nothing is derived again. Answers deleted, or deleted=false with deactivated=true. The dry run (the staging preview) says which of the two will happen.',
    useWhen:
      'The deduction ends and there is no end date to keep (a union fee stops, the bike lease is returned), or the line was created by mistake.',
    doNotUseFor:
      'Ending a line on a future date: gnubok_update_employee_recurring_line with valid_to, so the remaining months still derive. Removing a derived row from one draft payslip: edit that run.',
    pitfalls: [
      'deleted=false with deactivated=true is a success, not an error: a run already derived from the line, so it is kept for history and switched off.',
      'A line id that is not on this employee answers NOT_FOUND.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID, employee_recurring_line_id: 'erl_5b1c…' },
      response: {
        data: {
          employee_id: EMPLOYEE_EXAMPLE_ID,
          employee_recurring_line_id: 'erl_5b1c…',
          deleted: true,
          deactivated: false,
        },
        meta: META,
      },
    },
  },
  input: z.object({ employee_id: EMPLOYEE_ID, employee_recurring_line_id: RECURRING_LINE_ID }),
  output: z.object({
    employee_id: z.string().uuid(),
    employee_recurring_line_id: z.string().uuid(),
    deleted: z.boolean(),
    deactivated: z.boolean().describe('True when a salary run already derived from the line: kept and switched off instead.'),
  }),
  errorCodes: ['NOT_FOUND'],
  mcp: {
    name: 'gnubok_delete_employee_recurring_line',
    title: 'Delete Recurring Payslip Line',
    description:
      'Stage removing a recurring payslip line. A line a salary run already derived from is kept and deactivated instead, so its payslip rows keep their source; the preview says which will happen. To end it on a date, update valid_to instead.',
    keywords: ['ta bort löneavdrag', 'ta bort återkommande lönerad', 'avsluta avdrag', 'fackavgift', 'bruttolöneavdrag'],
    stage: {
      pendingType: 'delete_employee_recurring_line',
      title: () => 'Ta bort återkommande lönerad',
    },
  },
  run: async (ctx, { employee_id, employee_recurring_line_id }, { dryRun }) => {
    const result = await deleteEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      lineId: employee_recurring_line_id,
      dryRun,
    })
    if (!result.ok) return failed(result)
    const { deleted } = result.data
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: { employee_id, employee_recurring_line_id, would_delete: deleted, would_deactivate: !deleted },
      }
    }
    return { ok: true, data: { employee_id, employee_recurring_line_id, deleted, deactivated: !deleted } }
  },
})

// ---------------------------------------------------------------------------
// Remove an employee (soft delete)
// ---------------------------------------------------------------------------

export const employeesDelete = defineOperation({
  id: 'employees.delete',
  kind: 'write',
  scope: 'payroll:write',
  // Medium although the v1 DELETE declares low: nothing on the API sets
  // is_active back to true, so the approver gets the irreversibility warning.
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Remove an employee who has left: the employee is deactivated, never deleted.',
    description:
      'Sets is_active=false. The row is kept, because past salary runs reference it and their verifikationer are räkenskapsinformation under BFL 7 kap: every employee is handled this way, with or without salary history. New salary runs leave an inactive employee out and one cannot be added to a run; runs that already include the employee are not changed. Deactivating an inactive employee changes nothing. The dry run (the staging preview) names the employee and says whether anything would change.',
    useWhen:
      'An employee has left the company and should no longer appear in active rosters or be included in new salary runs.',
    doNotUseFor:
      'Recording the last day of employment: set employment_end with gnubok_update_employee. Erasing personal data: the row, its personnummer and the salary history are all kept.',
    pitfalls: [
      'Nothing on the API reactivates an employee: confirm the employee_id with gnubok_get_employee before staging.',
      'The row is not removed: registering the same person again with gnubok_create_employee is refused with EMPLOYEE_DUPLICATE_PERSONNUMMER.',
      'Past salary runs, payslips and AGI keep showing the employee.',
    ],
    example: {
      request: { employee_id: EMPLOYEE_EXAMPLE_ID },
      response: { data: { employee_id: EMPLOYEE_EXAMPLE_ID, is_active: false, changed: true }, meta: META },
    },
  },
  input: z.object({ employee_id: EMPLOYEE_ID }),
  output: z.object({
    employee_id: z.string().uuid(),
    is_active: z.literal(false),
    changed: z.boolean().describe('False when the employee was already inactive and nothing was written.'),
  }),
  errorCodes: ['EMPLOYEE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_delete_employee',
    title: 'Delete Employee',
    description:
      'Stage removing an employee who has left: the employee is deactivated (is_active=false) and new salary runs leave them out. Nothing is deleted: the row, personnummer and salary history are kept (BFL 7 kap). Nothing on the API reactivates them.',
    keywords: ['ta bort anställd', 'inaktivera anställd', 'anställd har slutat', 'slutat', 'avregistrera anställd'],
    stage: {
      pendingType: 'delete_employee',
      title: () => 'Inaktivera anställd',
    },
  },
  run: async (ctx, { employee_id }, { dryRun }) => {
    const result = await softDeleteEmployee(ctx.supabase, {
      companyId: ctx.companyId,
      employeeId: employee_id,
      dryRun,
    })
    if (!result.ok) {
      // A database failure travels as the raw error, so MCP classifies it
      // (a timeout is retryable) as it does any other.
      return result.code === 'EMPLOYEE_NOT_FOUND'
        ? { ok: false, code: result.code }
        : { ok: false, code: result.code, error: result.cause }
    }
    const { employee } = result.data
    if (!result.data.committed) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          employee_id,
          first_name: employee.first_name,
          last_name: employee.last_name,
          currently_active: employee.is_active,
          would_deactivate: employee.is_active,
          note: 'The employee is kept for the salary history and left out of new salary runs; nothing is deleted.',
        },
      }
    }
    return { ok: true, data: { employee_id, is_active: false as const, changed: result.data.changed } }
  },
})
