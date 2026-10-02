/**
 * What goes into a salary run, for agents over MCP: which runs exist, who is
 * on a draft run, the lines on each payslip, and the two lifecycle steps the
 * MCP surface lacked (marking a run paid, correcting a booked run):
 *
 *   salary-runs.list              gnubok_list_salary_runs            read
 *   salary-runs.employees.add     gnubok_add_salary_run_employee     staged
 *   salary-runs.employees.remove  gnubok_remove_salary_run_employee  staged
 *   salary-runs.lines.create      gnubok_add_payslip_line            staged
 *   salary-runs.lines.delete      gnubok_delete_payslip_line         staged
 *   salary-runs.correct           gnubok_correct_salary_run          staged
 *   salary-runs.mark-paid         gnubok_mark_salary_run_paid        staged
 *
 * MCP only, like vat-filings.ts: the v1 doors are the hand-written
 * /salary-runs routes, registered under these same operation ids, and binding
 * the operations to those paths would change their public contracts (bare
 * `id` fields, 204 answers, their dry-run previews). Both doors run the same
 * services, dry runs included: lib/salary/list-runs.ts, run-employees.ts,
 * payslip-lines.ts, correct-run.ts and mark-paid.ts. No rule lives here; each
 * run() translates the service's answer into qualified ids.
 *
 * Editing a line stays the hand-written gnubok_update_payslip_line, and
 * booking the hand-written gnubok_book_salary_run, which also walks an
 * approved run through paid.
 */
import { z } from 'zod'
import { AddEmployeeToRunSchema, CreateSalaryLineItemSchema } from '@/lib/api/schemas'
import { MAX_LIMIT } from '@/lib/api/v1/pagination'
import { roundOre } from '@/lib/money'
import { PartialCommitError } from '@/lib/pending-operations/errors'
import { correctSalaryRun, type CorrectSalaryRunFailure } from '@/lib/salary/correct-run'
import { listSalaryRuns, SalaryRunListFiltersSchema, SalaryRunStatusSchema } from '@/lib/salary/list-runs'
import { markSalaryRunPaid } from '@/lib/salary/mark-paid'
import { createPayslipLine, deletePayslipLine, type SalaryLineItemRow } from '@/lib/salary/payslip-lines'
import { addEmployeeToRun, removeEmployeeFromRun } from '@/lib/salary/run-employees'
import { defineOperation, type OperationOutcome } from './types'

const SALARY_RUN_ID = z.string().uuid().describe('The salary run (salary_run_id from gnubok_list_salary_runs).')
const EMPLOYEE_ID = z
  .string()
  .uuid()
  .describe(
    'The employee: its id in gnubok_list_employees, employee_id on gnubok_get_salary_run. Not the salary_run_employee_id.',
  )

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const RUN_EXAMPLE_ID = 'run_a8f1…'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** A service's `{ ok: false, code, details? }` as an operation failure. */
function failure(result: { code: string; details?: Record<string, unknown> }): Failure {
  return { ok: false, code: result.code, details: result.details }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const SalaryRunListItem = z.object({
  salary_run_id: z.string().uuid(),
  period_year: z.number().int(),
  period_month: z.number().int(),
  payment_date: z.string().describe('The payout date (YYYY-MM-DD); the run books on this date.'),
  deviation_period_start: z
    .string()
    .nullable()
    .describe('First day of the avvikelseperiod absence and worked days are read from.'),
  deviation_period_end: z.string().nullable(),
  status: SalaryRunStatusSchema.describe(
    'draft -> review (calculated) -> approved -> paid -> booked; corrected = replaced by a correction run.',
  ),
  voucher_series: z.string(),
  total_gross: z.number(),
  total_tax: z.number(),
  total_net: z.number(),
  total_avgifter: z.number(),
  total_employer_cost: z.number(),
  agi_generated_at: z.string().nullable(),
  agi_submitted_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  booked_at: z.string().nullable(),
  created_at: z.string(),
})

export const salaryRunsList = defineOperation({
  id: 'salary-runs.list',
  kind: 'read',
  scope: 'payroll:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s salary runs (lönekörningar) with their status and totals.',
    description:
      'Returns salary runs oldest first with their lifecycle status (draft, review, approved, paid, booked, corrected), payment date, avvikelseperiod and totals. Filter by period_year, period_month or status. Cursor pagination: pass next_cursor back as cursor; it is null on the last page.',
    useWhen:
      'Finding the salary_run_id of a period before any other payroll tool (calculate, add a payslip line, book, correct), finding the open draft, or checking which months are booked.',
    doNotUseFor:
      'One run\'s employees and calculation (gnubok_get_salary_run), one employee\'s payslip (gnubok_get_payslip) or the yearly lönejournal (gnubok_get_salary_journal).',
    pitfalls: [
      'A company has at most one live run per period_year and period_month. A corrected run and its correction run share the period; the correction run is the live one.',
      'Totals are 0 until the run is calculated (gnubok_calculate_salary_run).',
      'Oldest first: to find the current run, filter by period_year and period_month, or by status draft, instead of paging to the end.',
      'The page is in salary_runs with next_cursor; a cursor that no longer decodes starts from the first page.',
    ],
    example: {
      request: { period_year: 2026, period_month: 5 },
      response: {
        data: {
          salary_runs: [
            {
              salary_run_id: RUN_EXAMPLE_ID,
              period_year: 2026,
              period_month: 5,
              payment_date: '2026-05-25',
              status: 'draft',
              voucher_series: 'L',
              total_gross: 0,
              total_net: 0,
            },
          ],
          next_cursor: null,
        },
        meta: META,
      },
    },
  },
  input: SalaryRunListFiltersSchema.extend({
    period_month: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .optional()
      .describe('Only runs for this month (1-12); combine with period_year.'),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Page size, 1-${MAX_LIMIT} (default 50).`),
  }),
  output: z.object({ salary_runs: z.array(SalaryRunListItem), next_cursor: z.string().nullable() }),
  mcp: {
    name: 'gnubok_list_salary_runs',
    title: 'List Salary Runs',
    description:
      'List salary runs (lönekörningar) oldest first: status (draft, review, approved, paid, booked, corrected), payment date and totals. Filter by period_year, period_month or status to find a salary_run_id; paginate with cursor = next_cursor.',
    keywords: ['lönekörningar', 'lönekörning', 'lista lönekörningar', 'löneperiod', 'lönemånad', 'löneutbetalning', 'löner'],
  },
  run: async (ctx, input) => {
    const outcome = await listSalaryRuns(ctx, {
      periodYear: input.period_year,
      periodMonth: input.period_month,
      status: input.status,
      cursor: input.cursor,
      limit: input.limit,
    })
    if (!outcome.ok) return outcome
    return {
      ok: true,
      data: {
        salary_runs: outcome.data.runs.map(({ id, ...run }) => ({ salary_run_id: id, ...run })),
        next_cursor: outcome.data.next_cursor,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Add an employee to a draft run
// ---------------------------------------------------------------------------

const RunEmployeeAdded = z.object({
  salary_run_employee_id: z.string().uuid().describe('The employee\'s row on this run, not the employee id.'),
  salary_run_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  salary_type: z.string().describe('monthly or hourly.'),
  employment_degree: z.number().describe('Sysselsättningsgrad in percent.'),
  monthly_salary: z
    .number()
    .describe('Full-time monthly salary taken onto the run; the Grundlön line applies employment_degree.'),
  hours_worked: z.number().nullable(),
  tax_table_number: z.number().nullable(),
  tax_column: z.number().nullable(),
})

export const salaryRunsEmployeesAdd = defineOperation({
  id: 'salary-runs.employees.add',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Add an employee to a draft salary run.',
    description:
      'Attaches an active employee to a draft run: takes a snapshot of their pay configuration (salary type, monthly salary, sysselsättningsgrad, tax table and column) onto the run and seeds the base salary line (Grundlön, or Timlön from hours_worked for an hourly employee). Recalculate the run afterwards. Dry-runnable: the preview is the snapshot the run would take.',
    useWhen:
      'The run lacks an employee: hired after the run was created, or removed by mistake. Creating a run (gnubok_create_salary_run) already adds every active employee.',
    doNotUseFor:
      'Changing this month\'s pay for an employee already on the run (gnubok_set_run_salary) or the employee\'s standard pay (gnubok_update_employee).',
    pitfalls: [
      'Draft runs only: SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced; gnubok_revert_salary_run brings a run in review back to draft.',
      'An employee already on the run is refused with SALARY_RUN_EMPLOYEE_DUPLICATE (details.salary_run_employee_id).',
      'The snapshot freezes salary, degree and tax table when the employee is added: later edits to the employee do not reach this run. Removing and adding again retakes it.',
      'An inactive or unknown employee answers EMPLOYEE_NOT_FOUND.',
      'Tax and totals include the employee only after gnubok_calculate_salary_run.',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID, employee_id: 'emp_77b2…' },
      response: {
        data: {
          salary_run_employee_id: 'sre_a8f1…',
          salary_run_id: RUN_EXAMPLE_ID,
          employee_id: 'emp_77b2…',
          salary_type: 'monthly',
          employment_degree: 100,
          monthly_salary: 35000,
          hours_worked: null,
          tax_table_number: 33,
          tax_column: 1,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    ...AddEmployeeToRunSchema.shape,
    employee_id: AddEmployeeToRunSchema.shape.employee_id.describe(
      'The employee to add: its id in gnubok_list_employees. Must be active.',
    ),
    hours_worked: AddEmployeeToRunSchema.shape.hours_worked.describe(
      'Hours worked this period, for an hourly employee: seeds the Timlön line as hours x hourly rate. Omit for a monthly employee.',
    ),
  }),
  output: RunEmployeeAdded,
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_EMPLOYEES_NOT_DRAFT', 'EMPLOYEE_NOT_FOUND', 'SALARY_RUN_EMPLOYEE_DUPLICATE'],
  mcp: {
    name: 'gnubok_add_salary_run_employee',
    title: 'Add Employee To Salary Run',
    description:
      'Stage adding an active employee to a draft salary run: snapshots their salary, degree and tax table and seeds the Grundlön or Timlön line (pass hours_worked for hourly staff). Creating a run already adds every active employee. Recalculate afterwards.',
    keywords: ['lägg till anställd', 'anställd i lönekörning', 'ny anställd lönekörning', 'saknas i lönekörningen', 'timlön timmar'],
    stage: {
      pendingType: 'add_salary_run_employee',
      title: () => 'Lägg till anställd i lönekörningen',
    },
  },
  run: async (ctx, { salary_run_id, employee_id, hours_worked }, { dryRun }) => {
    const result = await addEmployeeToRun(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      employeeId: employee_id,
      hoursWorked: hours_worked ?? null,
      dryRun,
    })
    if (!result.ok) return failure(result)
    const row = result.data
    const snapshot = {
      salary_run_id,
      employee_id: row.employee_id,
      salary_type: row.salary_type,
      employment_degree: row.employment_degree,
      monthly_salary: row.monthly_salary,
      hours_worked: row.hours_worked,
      tax_table_number: row.tax_table_number,
      tax_column: row.tax_column,
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...snapshot,
          note: 'Seeds the Grundlön (or Timlön) line. Recalculate the run afterwards.',
        },
      }
    }
    return { ok: true, created: true, data: { salary_run_employee_id: row.id as string, ...snapshot } }
  },
})

// ---------------------------------------------------------------------------
// Remove an employee from a draft run
// ---------------------------------------------------------------------------

export const salaryRunsEmployeesRemove = defineOperation({
  id: 'salary-runs.employees.remove',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Remove an employee from a draft salary run.',
    description:
      'Detaches the employee from a draft run and deletes their payslip lines in it, manual ones included. The employee record is untouched: this only changes who the run pays. Dry-runnable.',
    useWhen:
      'An employee should not be paid this period (unpaid leave all month, employment ended) but was added when the run was created.',
    doNotUseFor:
      'Ending the employment (employment_end with gnubok_update_employee). A month without pay that should still be on record: keep the employee with this month\'s salary 0 (gnubok_set_run_salary) for a nollkörning.',
    pitfalls: [
      'Draft runs only: SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced; gnubok_revert_salary_run brings a run in review back to draft.',
      'Deletes every line of the employee on this run, manual ones included; adding the employee back retakes the pay snapshot but not those lines.',
      'An employee who is not on the run answers SALARY_RUN_EMPLOYEE_NOT_FOUND.',
      'Recalculate the run afterwards (gnubok_calculate_salary_run) so the totals drop the employee.',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID, employee_id: 'emp_77b2…' },
      response: { data: { salary_run_id: RUN_EXAMPLE_ID, employee_id: 'emp_77b2…', removed: true }, meta: META },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID, employee_id: EMPLOYEE_ID }),
  output: z.object({
    salary_run_id: z.string().uuid(),
    employee_id: z.string().uuid(),
    removed: z.literal(true),
  }),
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_EMPLOYEES_NOT_DRAFT', 'SALARY_RUN_EMPLOYEE_NOT_FOUND'],
  mcp: {
    name: 'gnubok_remove_salary_run_employee',
    title: 'Remove Employee From Salary Run',
    description:
      'Stage removing an employee from a draft salary run together with all their payslip lines on it, manual ones included. The employee record is untouched. For a month without pay on record, set this month\'s salary to 0 instead. Recalculate afterwards.',
    keywords: ['ta bort anställd', 'ta bort från lönekörning', 'ingen lön denna månad', 'tjänstledig hela månaden'],
    stage: {
      pendingType: 'remove_salary_run_employee',
      title: () => 'Ta bort anställd från lönekörningen',
    },
  },
  run: async (ctx, { salary_run_id, employee_id }, { dryRun }) => {
    const result = await removeEmployeeFromRun(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      employeeId: employee_id,
      dryRun,
    })
    if (!result.ok) return failure(result)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          salary_run_id,
          employee_id,
          would_remove: true,
          note: 'Removes the employee and every payslip line of theirs on this run, manual ones included. The employee record is untouched.',
        },
      }
    }
    return { ok: true, data: { salary_run_id, employee_id, removed: true as const } }
  },
})

// ---------------------------------------------------------------------------
// Add a payslip line
// ---------------------------------------------------------------------------

const PayslipLineOut = z.object({
  salary_line_item_id: z.string().uuid(),
  salary_run_id: z.string().uuid(),
  salary_run_employee_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  item_type: z.string(),
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number(),
  is_taxable: z.boolean(),
  is_avgift_basis: z.boolean(),
  is_vacation_basis: z.boolean(),
  is_gross_deduction: z.boolean(),
  is_net_deduction: z.boolean(),
  account_number: z.string().nullable().describe('BAS account, as a string (e.g. "7210").'),
  sort_order: z.number(),
  one_off_tax_percent: z.number().nullable(),
  vacation_category: z.string().nullable(),
  vacation_saved_year: z.string().nullable(),
})

type PayslipLine = z.infer<typeof PayslipLineOut>

function toPayslipLine(
  row: Omit<SalaryLineItemRow, 'id' | 'created_at' | 'updated_at'> & { id: string | null },
  salaryRunId: string,
  employeeId: string,
): Omit<PayslipLine, 'salary_line_item_id'> & { salary_line_item_id: string | null } {
  return {
    salary_line_item_id: row.id,
    salary_run_id: salaryRunId,
    salary_run_employee_id: row.salary_run_employee_id,
    employee_id: employeeId,
    item_type: row.item_type,
    description: row.description,
    quantity: row.quantity,
    unit_price: row.unit_price,
    amount: row.amount,
    is_taxable: row.is_taxable,
    is_avgift_basis: row.is_avgift_basis,
    is_vacation_basis: row.is_vacation_basis,
    is_gross_deduction: row.is_gross_deduction,
    is_net_deduction: row.is_net_deduction,
    account_number: row.account_number,
    sort_order: row.sort_order,
    one_off_tax_percent: row.one_off_tax_percent ?? null,
    vacation_category: row.vacation_category ?? null,
    vacation_saved_year: row.vacation_saved_year ?? null,
  }
}

/** The v1 line body: the path (here the input) names the employee, never the roster row. */
const LINE = CreateSalaryLineItemSchema.omit({ salary_run_employee_id: true }).shape

export const salaryRunsLinesCreate = defineOperation({
  id: 'salary-runs.lines.create',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Add a payslip line for one employee on a draft salary run.',
    description:
      'Creates a payslip line (bonus, provision, övertid, traktamente, milersättning, bruttolöneavdrag, nettolöneavdrag, förskott, förmån or semesterdagar) for one employee on a draft run. account_number defaults from item_type. Amounts are rounded to whole öre. one_off_tax_percent (engångsskatt) taxes the line at that verified flat percentage instead of the monthly table; allowed on a positive taxable bonus, commission, other, correction or semesterersattning line. A vacation line (item_type vacation, quantity = days) may carry vacation_category to say which days are taken: paid (Betalda, the default), extra_paid (Extra betalda), saved (Sparade, optionally one origin year in vacation_saved_year), unpaid (Obetalda) or advance (Förskott). Tax and totals change only when the run is recalculated. Dry-runnable: the preview is the line as it would be stored.',
    useWhen:
      'A one-off pay component before calculating: a bonus or provision, övertid, traktamente or milersättning, a deduction or förskott, or vacation days taken. A bonus or final-settlement semesterersättning that Skatteverket taxes as an engångsbelopp: send one_off_tax_percent with the percentage you verified for the employee.',
    doNotUseFor:
      'This month\'s base salary (gnubok_set_run_salary: the calculation rebuilds the Grundlön line), absence (gnubok_register_absence: the calculation derives sick, VAB and parental lines), utlägg (gnubok_attach_salary_expense_claims links the claim so booking settles it) or changing a line (gnubok_update_payslip_line).',
    pitfalls: [
      'Draft runs only: SALARY_RUN_LINE_NOT_DRAFT once the run has advanced; gnubok_revert_salary_run brings a run in review back to draft. The employee must be on the run, otherwise SALARY_RUN_EMPLOYEE_NOT_FOUND.',
      'The calculation owns every sick_*, vab, parental_leave, unpaid_leave, overtime_50, overtime_100 and ob_* line (it rebuilds them from registered absence and from worked hours under the company\'s OB and övertid rules), so those types are refused with SALARY_LINE_CALCULATED. Put a one-off övertid amount on item_type overtime and a one-off OB amount on item_type other.',
      'The flags are not derived from item_type: send them. Pay (bonus, commission, overtime, other, correction) keeps the defaults. Skattefri traktamente or milersättning: is_taxable, is_avgift_basis and is_vacation_basis false. Skattepliktig traktamente or milersättning: is_vacation_basis false. Bruttolöneavdrag: is_gross_deduction true, is_vacation_basis false. Nettolöneavdrag and förskott: is_net_deduction true, is_taxable, is_avgift_basis and is_vacation_basis false.',
      'Deductions carry a negative amount, as the dashboard stores them: the booking credits a nettolöneavdrag\'s account only when its amount is negative.',
      'account_number defaults as for an employee (bonus "7210") even when the employee is a company owner, whose Grundlön books on "7220": send account_number on an owner\'s line.',
      'one_off_tax_percent is the percentage YOU verified against Skatteverket\'s engångsbelopp table for the employee\'s yearly income; it is never estimated. It is refused (VALIDATION_ERROR) on deductions, benefits, non-taxable rows and non-positive amounts. A valid jämkning decision on the employee overrides it. Equal percentages are summed before the öre are dropped, so splitting one bonus over two rows never changes the withholding.',
      'vacation_category is only valid on item_type vacation (VALIDATION_ERROR otherwise) and vacation_saved_year only with category saved. Omitted category = paid. The vacation ledger splits the booked run\'s days by category: saved consumes the named origin year, or the oldest saved year first when omitted; unpaid and advance consume their own pools.',
      'Adding a line does not recompute tax or totals: run gnubok_calculate_salary_run afterwards.',
    ],
    example: {
      request: {
        salary_run_id: RUN_EXAMPLE_ID,
        employee_id: 'emp_77b2…',
        item_type: 'bonus',
        description: 'Kvartalsbonus Q2',
        amount: 5000,
        one_off_tax_percent: 30,
      },
      response: {
        data: {
          salary_line_item_id: 'sli_31c9…',
          salary_run_id: RUN_EXAMPLE_ID,
          employee_id: 'emp_77b2…',
          item_type: 'bonus',
          description: 'Kvartalsbonus Q2',
          amount: 5000,
          account_number: '7210',
          one_off_tax_percent: 30,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    employee_id: EMPLOYEE_ID,
    ...LINE,
    item_type: LINE.item_type.describe(
      'Pay: bonus, commission (provision), overtime (övertid, quantity = hours), other, correction. ' +
        'Travel: traktamente_taxfree or traktamente_taxable (quantity = days), mileage_taxfree or mileage_taxable (milersättning, quantity = mil). ' +
        'Deductions: gross_deduction_pension or gross_deduction_other (bruttolöneavdrag); net_deduction_advance (förskott), net_deduction_union, net_deduction_benefit_payment or net_deduction_other (nettolöneavdrag). ' +
        'vacation: semesterdagar taken (quantity = days). benefit_*: förmånsvärde (registered benefits are added at calculation). ' +
        'The calculation replaces sick_*, vab, parental_leave, overtime_50, overtime_100 and ob_* lines with ones derived from absence and worked hours, ' +
        'so a one-off OB amount goes on other. Not for the base salary (gnubok_set_run_salary), absence (gnubok_register_absence) ' +
        'or utlägg (gnubok_attach_salary_expense_claims).',
    ),
    description: LINE.description.describe('Text on the payslip, e.g. "Kvartalsbonus Q2".'),
    quantity: LINE.quantity.describe(
      'Hours (övertid), days (traktamente, vacation) or mil (milersättning). For item_type vacation: the vacation days taken.',
    ),
    unit_price: LINE.unit_price.describe('SEK per unit, shown on the payslip; amount is not derived from it.'),
    amount: LINE.amount.describe(
      'SEK, rounded to whole öre. Positive for pay and reimbursements, negative for a deduction (is_gross_deduction or is_net_deduction).',
    ),
    is_taxable: LINE.is_taxable.describe('Default true. False on skattefri traktamente or milersättning and on nettolöneavdrag.'),
    is_avgift_basis: LINE.is_avgift_basis.describe(
      'Default true. False on skattefri traktamente or milersättning and on nettolöneavdrag.',
    ),
    is_vacation_basis: LINE.is_vacation_basis.describe(
      'Default true (semestergrundande). False on traktamente, milersättning and every deduction.',
    ),
    is_gross_deduction: LINE.is_gross_deduction.describe(
      'True on a bruttolöneavdrag (reduces gross pay before tax), with a negative amount.',
    ),
    is_net_deduction: LINE.is_net_deduction.describe(
      'True on a nettolöneavdrag or förskott (reduces the payout after tax), with a negative amount.',
    ),
    account_number: LINE.account_number.describe(
      'BAS account as a string. Omit for the item type\'s default (bonus "7210", förskott "1613"); a company owner\'s pay books on "7220".',
    ),
    sort_order: LINE.sort_order.describe('Position on the payslip. Default 0.'),
    one_off_tax_percent: LINE.one_off_tax_percent.describe(
      'Engångsskatt: the percentage you verified in Skatteverket\'s engångsbelopp table for this employee. Only on a positive taxable bonus, commission, other, correction or semesterersattning line. Omitted or null = the monthly tax table.',
    ),
    vacation_category: LINE.vacation_category.describe(
      'Only on item_type vacation: which days are taken. paid (Betalda, the default), extra_paid (Extra betalda), saved (Sparade), unpaid (Obetalda) or advance (Förskott).',
    ),
    vacation_saved_year: LINE.vacation_saved_year.describe(
      'Only with vacation_category saved: the year (YYYY) the saved days come from. Omitted = oldest first.',
    ),
  }),
  output: PayslipLineOut,
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_LINE_NOT_DRAFT', 'SALARY_RUN_EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR', 'SALARY_LINE_CALCULATED'],
  mcp: {
    name: 'gnubok_add_payslip_line',
    title: 'Add Payslip Line',
    description:
      'Stage a payslip line for one employee on a draft salary run: bonus, provision, övertid, traktamente, milersättning, avdrag, förskott or semesterdagar (vacation, quantity = days). Deductions are negative; absence and OB/övertid-rule types are refused. Recalculate after.',
    keywords: [
      'lönerad',
      'lönebeskedsrad',
      'lönetillägg',
      'bonus',
      'provision',
      'övertid',
      'ob-tillägg',
      'traktamente',
      'milersättning',
      'löneavdrag',
      'bruttolöneavdrag',
      'nettolöneavdrag',
      'förskott',
      'semesterdagar',
      'engångsskatt',
    ],
    stage: {
      pendingType: 'add_payslip_line',
      title: (input) =>
        `Lägg till lönebeskedsrad: ${String(input.description)} (${roundOre(Number(input.amount))} kr)`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const { salary_run_id, employee_id, ...line } = input
    const result = await createPayslipLine(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      target: { employeeId: employee_id },
      input: line,
      dryRun,
    })
    if (!result.ok) return failure(result)
    const { salary_line_item_id, ...row } = toPayslipLine(result.data, salary_run_id, employee_id)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...row,
          note: 'Tax and totals include the line only after the run is recalculated (gnubok_calculate_salary_run).',
        },
      }
    }
    return { ok: true, created: true, data: { salary_line_item_id: salary_line_item_id as string, ...row } }
  },
})

// ---------------------------------------------------------------------------
// Delete a payslip line
// ---------------------------------------------------------------------------

export const salaryRunsLinesDelete = defineOperation({
  id: 'salary-runs.lines.delete',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete a payslip line from a draft salary run.',
    description:
      'Removes one payslip line while the run is a draft. Lines the calculation derives (absence, OB and övertid from worked hours, registered benefits, recurring lines) come back at the next calculation: change their source instead. Dry-runnable.',
    useWhen: 'A manual line (bonus, deduction, traktamente) was added by mistake and the run is still a draft.',
    doNotUseFor:
      'Changing a line (gnubok_update_payslip_line), removing an employee from the run (gnubok_remove_salary_run_employee), or suppressing a derived line (fix the absence, worked hours, benefit or recurring line behind it).',
    pitfalls: [
      'Draft runs only: SALARY_RUN_LINE_NOT_DRAFT once the run has advanced; gnubok_revert_salary_run brings a run in review back to draft.',
      'A salary_line_item_id from another run answers SALARY_LINE_NOT_FOUND. The ids are in gnubok_get_payslip (line_items[].salary_line_item_id).',
      'A line the calculation derives (absence, Övertid 50/100 % and OB rows, förmån and recurring-line rows, the engine\'s semesterersättning and öresavrundning rows) answers SALARY_LINE_CALCULATED: the next calculation would bring it back. Change the source: gnubok_delete_absence, gnubok_set_worked_days, the förmån or the recurring line.',
      'Deleting an utlägg line that gnubok_attach_salary_expense_claims added leaves the claim open: attach it again or repay it another way.',
      'Recalculate the run afterwards (gnubok_calculate_salary_run).',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID, salary_line_item_id: 'sli_31c9…' },
      response: {
        data: { salary_run_id: RUN_EXAMPLE_ID, salary_line_item_id: 'sli_31c9…', deleted: true },
        meta: META,
      },
    },
  },
  input: z.object({
    salary_run_id: SALARY_RUN_ID,
    salary_line_item_id: z
      .string()
      .uuid()
      .describe('The line to delete (line_items[].salary_line_item_id from gnubok_get_payslip).'),
  }),
  output: z.object({
    salary_run_id: z.string().uuid(),
    salary_line_item_id: z.string().uuid(),
    deleted: z.literal(true),
  }),
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_LINE_NOT_DRAFT', 'SALARY_LINE_NOT_FOUND', 'SALARY_LINE_CALCULATED'],
  mcp: {
    name: 'gnubok_delete_payslip_line',
    title: 'Delete Payslip Line',
    description:
      'Stage deleting one payslip line from a draft salary run (salary_line_item_id from gnubok_get_payslip). Lines the calculation derives (absence, OB, benefits, recurring lines) are refused: change their source. To change a line, use gnubok_update_payslip_line.',
    keywords: ['ta bort lönerad', 'radera lönebeskedsrad', 'ta bort bonus', 'ta bort avdrag', 'fel lönerad'],
    stage: {
      pendingType: 'delete_payslip_line',
      title: () => 'Ta bort lönebeskedsrad',
    },
  },
  run: async (ctx, { salary_run_id, salary_line_item_id }, { dryRun }) => {
    const result = await deletePayslipLine(ctx.supabase, {
      companyId: ctx.companyId,
      salaryRunId: salary_run_id,
      lineId: salary_line_item_id,
      dryRun,
    })
    if (!result.ok) return failure(result)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          salary_run_id,
          salary_line_item_id,
          would_delete: true,
          note: 'A line the calculation derives (absence, OB, benefit, recurring line) comes back at the next calculation.',
        },
      }
    }
    return { ok: true, data: { salary_run_id, salary_line_item_id, deleted: true as const } }
  },
})

// ---------------------------------------------------------------------------
// Correct a booked run (rättelsekörning)
// ---------------------------------------------------------------------------

const CorrectionRunOut = z.object({
  salary_run_id: z.string().uuid().describe('The new draft: edit, calculate and book this run.'),
  period_year: z.number().int(),
  period_month: z.number().int(),
  payment_date: z.string(),
  status: z.literal('draft'),
  is_correction: z.literal(true),
  corrects_run_id: z.string().uuid(),
  deviation_period_start: z.string().nullable(),
  deviation_period_end: z.string().nullable(),
})

const SalaryRunCorrected = z.object({
  original_run_id: z.string().uuid(),
  original_status: z.literal('corrected'),
  correction_run: CorrectionRunOut,
  reversed_entry_ids: z
    .array(z.string().uuid())
    .describe('The original run\'s verifikat, now reversed with storno.'),
  warnings: z
    .array(z.string())
    .describe('Problems after the correction run was created, e.g. an employee not copied: add them with gnubok_add_salary_run_employee.'),
})

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'unknown error'
}

/**
 * The correction's failures. A precondition refusal passes its code through.
 * A failure after the first storno is a partial commit: those storno
 * verifikat are live and immutable, so the approval must land as
 * failed_partial with their ids, not as a clean rejection (#842). The
 * service resumes where it stopped, so staging the correction again finishes
 * the job.
 */
function correctionFailure(salaryRunId: string, result: CorrectSalaryRunFailure): Failure {
  switch (result.code) {
    case 'SALARY_RUN_NOT_FOUND':
      return { ok: false, code: result.code }
    case 'SALARY_RUN_CORRECT_NOT_BOOKED':
    case 'SALARY_RUN_ALREADY_CORRECTED':
      return { ok: false, code: result.code, details: result.details }
    case 'DB_ERROR':
      if (result.stage === 'insert_correction_run') {
        return {
          ok: false,
          code: 'UNKNOWN_ERROR',
          error: new PartialCommitError(
            `The salary run's verifikat are reversed and the run is marked corrected, but the correction run was not created: ${errorMessage(result.error)}. Stage gnubok_correct_salary_run again to create it; nothing is reversed twice.`,
            { corrected_salary_run_id: salaryRunId },
            result.error,
          ),
        }
      }
      return { ok: false, code: 'UNKNOWN_ERROR', error: result.error }
    case 'REVERSAL_FAILED': {
      const { reversed_entry_ids: reversed, remaining_entry_ids: remaining } = result.details
      // Nothing posted yet (e.g. PERIOD_LOCKED on the first storno): a clean
      // failure that carries the bookkeeping error as it is.
      if (reversed.length === 0) return { ok: false, code: 'UNKNOWN_ERROR', error: result.error }
      const total = reversed.length + 1 + remaining.length
      return {
        ok: false,
        code: 'UNKNOWN_ERROR',
        error: new PartialCommitError(
          `The salary run correction stopped after reversing ${reversed.length} of ${total} verifikat: ${errorMessage(result.error)}. The run is still booked. Fix the cause and stage gnubok_correct_salary_run again: it skips the verifikat already reversed.`,
          Object.fromEntries(reversed.map((entryId, i) => [`reversed_journal_entry_id_${i + 1}`, entryId])),
          result.error,
        ),
      }
    }
  }
}

export const salaryRunsCorrect = defineOperation({
  id: 'salary-runs.correct',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary:
      'Correct a booked salary run (rättelsekörning): storno its verifikat and open a new draft for the same period.',
    description:
      'Per Bokföringslagen 5 kap 5 § a booked salary run is never edited: this reverses every verifikat the run posted (salary, arbetsgivaravgifter, semesterlöneskuld, pension) with storno entries, marks the original corrected, revokes the payslip links that were emailed for it, and creates a new draft run for the same period (is_correction, corrects_run_id pointing back) with the roster and payslip lines copied, so the operator edits a populated draft. Dry-runnable: the preview names the verifikat that would be reversed and the draft that would be created.',
    useWhen:
      'A booked month turns out wrong: a missing line, a wrong salary, a benefit that was not on the payslip. Correct first, then edit the correction run\'s lines and take it through calculate, approve and book, and file the AGI again.',
    doNotUseFor:
      'A run that is not booked: nothing is posted, so change it in place (a draft directly, a run in review after gnubok_revert_salary_run, an approved run after gnubok_unapprove_salary_run and then the revert). One verifikat outside the salary flow (gnubok_correct_entry). Re-sending payslips without changing amounts (gnubok_send_payslips).',
    pitfalls: [
      'Only a booked run: any other status is refused with SALARY_RUN_CORRECT_NOT_BOOKED (details.current_status).',
      'Nothing is edited or deleted: each of the run\'s verifikat gets a storno verifikat in the same series on the original date, so a locked period stops the correction with PERIOD_LOCKED before anything is written.',
      'The correction run is a draft with the roster and lines copied; this posts nothing for it. Edit it (gnubok_add_payslip_line, gnubok_update_payslip_line, gnubok_set_run_salary), then gnubok_calculate_salary_run and gnubok_book_salary_run.',
      'A run that is already corrected is refused with SALARY_RUN_ALREADY_CORRECTED and details.correction_run_id: continue in that run.',
      'The original\'s emailed payslip links stop working at once; send the correction run\'s payslips when it is approved.',
      'File the AGI for the period again after the correction run is booked (gnubok_generate_agi): Skatteverket gets the corrected figures, not a difference.',
      'If a storno fails after others were posted, approval ends failed_partial and names the verifikat already reversed; the run stays booked. Fix the cause and stage the correction again: it skips what is already reversed.',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID },
      response: {
        data: {
          original_run_id: RUN_EXAMPLE_ID,
          original_status: 'corrected',
          correction_run: {
            salary_run_id: 'run_c0rr…',
            period_year: 2026,
            period_month: 5,
            payment_date: '2026-05-25',
            status: 'draft',
            is_correction: true,
            corrects_run_id: RUN_EXAMPLE_ID,
            deviation_period_start: '2026-04-01',
            deviation_period_end: '2026-04-30',
          },
          reversed_entry_ids: ['je_salary…', 'je_avg…', 'je_vac…'],
          warnings: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID.describe('The booked salary run to correct.') }),
  output: SalaryRunCorrected,
  errorCodes: [
    'SALARY_RUN_NOT_FOUND',
    'SALARY_RUN_CORRECT_NOT_BOOKED',
    'SALARY_RUN_ALREADY_CORRECTED',
    'PERIOD_LOCKED',
    'CANNOT_REVERSE_NON_POSTED',
  ],
  mcp: {
    name: 'gnubok_correct_salary_run',
    title: 'Correct Booked Salary Run',
    description:
      'Stage a rättelsekörning for a booked salary run: storno of every verifikat it posted, the run marked corrected and a new draft for the same period with its roster and lines copied. Then edit, calculate and book the draft and file the AGI again.',
    keywords: [
      'rättelsekörning',
      'rätta lönekörning',
      'korrigera lönekörning',
      'korrigeringskörning',
      'fel i lönen',
      'storno lön',
      'ändra bokförd lön',
    ],
    stage: {
      pendingType: 'correct_salary_run',
      title: () => 'Rätta bokförd lönekörning (storno och ny korrigeringskörning)',
    },
  },
  run: async (ctx, { salary_run_id }, { dryRun }) => {
    const result = await correctSalaryRun(ctx.supabase, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      runId: salary_run_id,
      dryRun,
    })
    if (!result.ok) return correctionFailure(salary_run_id, result)

    if (result.dryRun) {
      const { original_run, entries_to_reverse, correction_run } = result.preview
      return {
        ok: true,
        dryRun: true,
        preview: {
          salary_run_id,
          period_year: original_run.period_year,
          period_month: original_run.period_month,
          payment_date: original_run.payment_date,
          would_change_status_from: original_run.status,
          would_change_status_to: 'corrected',
          resumes_earlier_correction: original_run.status === 'corrected',
          would_reverse_entry_ids: entries_to_reverse,
          would_create_correction_run: correction_run,
          note: 'Each verifikat in would_reverse_entry_ids gets a storno verifikat on its own date, the payslip links emailed for the run stop working, and the new draft gets the roster and lines. File the AGI for the period again once the correction run is booked.',
        },
      }
    }

    for (const warning of result.warnings) {
      ctx.log.warn('salary run correction warning', { salaryRunId: salary_run_id, message: warning })
    }
    const run = result.correctionRun
    return {
      ok: true,
      data: {
        original_run_id: result.originalRunId,
        original_status: 'corrected' as const,
        correction_run: {
          salary_run_id: run.id,
          period_year: run.period_year,
          period_month: run.period_month,
          payment_date: run.payment_date,
          status: 'draft' as const,
          is_correction: true as const,
          corrects_run_id: result.originalRunId,
          deviation_period_start: run.deviation_period_start ?? null,
          deviation_period_end: run.deviation_period_end ?? null,
        },
        reversed_entry_ids: result.reversedEntryIds,
        warnings: result.warnings,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Mark an approved run paid
// ---------------------------------------------------------------------------

export const salaryRunsMarkPaid = defineOperation({
  id: 'salary-runs.mark-paid',
  kind: 'write',
  scope: 'payroll:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Mark an approved salary run as paid, without booking it.',
    description:
      'Moves a salary run from approved to paid and stamps paid_at with the server time. It records that the net pay went out: it makes no payment and posts no verifikat. gnubok_book_salary_run marks an approved run paid on its way to booked, so this is only needed when the payment should be on record before the run is booked. Dry-runnable.',
    useWhen:
      'The salaries went out (a bank transfer, or the payment file uploaded in the bank) and the run is approved, but booking waits, e.g. for the bank statement.',
    doNotUseFor:
      'Paying the salaries (the transfer or the payment file in the bank). Booking the run: gnubok_book_salary_run marks it paid on the way, so call it directly. Undoing a payment: nothing moves a run back from paid; once booked, gnubok_correct_salary_run corrects it.',
    pitfalls: [
      'Only an approved run: any other status is refused with SALARY_RUN_MARK_PAID_NOT_APPROVED (details.current_status); a run that moved on meanwhile answers details.reason race.',
      'paid_at is the server time when the operation is approved; a payment date cannot be supplied.',
      'Paid is one-way: there is no unpaid step, and an approval recall (gnubok_unapprove_salary_run) refuses a paid run.',
    ],
    example: {
      request: { salary_run_id: RUN_EXAMPLE_ID },
      response: {
        data: { salary_run_id: RUN_EXAMPLE_ID, status: 'paid', paid_at: '2026-05-25T08:00:00Z' },
        meta: META,
      },
    },
  },
  input: z.object({ salary_run_id: SALARY_RUN_ID.describe('The approved salary run that was paid.') }),
  output: z.object({
    salary_run_id: z.string().uuid(),
    status: z.literal('paid'),
    paid_at: z.string(),
  }),
  errorCodes: ['SALARY_RUN_NOT_FOUND', 'SALARY_RUN_MARK_PAID_NOT_APPROVED'],
  mcp: {
    name: 'gnubok_mark_salary_run_paid',
    title: 'Mark Salary Run Paid',
    description:
      'Stage marking an approved salary run as paid once the salaries went out; paid_at is the approval time. Posts nothing and pays nothing. Not needed before booking: gnubok_book_salary_run marks an approved run paid on its way to booked.',
    keywords: ['markera utbetald', 'lön utbetald', 'lönen betald', 'betald lönekörning', 'utbetalning genomförd'],
    stage: {
      pendingType: 'mark_salary_run_paid',
      title: () => 'Markera lönekörningen som utbetald',
    },
  },
  run: async (ctx, { salary_run_id }, { dryRun }) => {
    const outcome = await markSalaryRunPaid(ctx, salary_run_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { salary_run_id: outcome.data.id, status: 'paid' as const, paid_at: outcome.data.paid_at },
    }
  },
})
