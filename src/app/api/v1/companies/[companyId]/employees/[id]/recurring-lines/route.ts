/**
 * /api/v1/companies/{companyId}/employees/{id}/recurring-lines
 *
 * GET  : list an employee's recurring lines (standing payslip rows).
 * POST : create one.
 *
 * A recurring line is derived into every salary run whose payment_date
 * falls inside valid_from..valid_to at :calculate time
 * (lib/salary/run-calculation.ts, step 8d3): a benefit bike gross deduction,
 * a union fee, a net deduction for a benefit the employee pays for. The
 * commands live in lib/salary/employee-recurring-lines.ts and are shared
 * with the dashboard route.
 */

import { z } from 'zod'
import { ok, created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateEmployeeRecurringLineSchema, RecurringLineItemTypeSchema } from '@/lib/api/schemas'
import {
  createEmployeeRecurringLine,
  listEmployeeRecurringLines,
  type EmployeeRecurringLinePreview,
  type EmployeeRecurringLineRow,
} from '@/lib/salary/employee-recurring-lines'

// Route files may only export HTTP handlers, so the resource schema, the
// mapper and the shared pitfalls are repeated in [lineId]/route.ts (same
// convention as the salary-runs lines pair).
const RecurringLine = z.object({
  employee_recurring_line_id: z.string().uuid(),
  item_type: RecurringLineItemTypeSchema,
  description: z.string(),
  amount: z.number(),
  account_number: z.string().nullable(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
  is_active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
})

/**
 * Public shape: qualified id, no tenancy columns. A dry-run create preview
 * has no id or timestamps yet, so those keys are omitted rather than null.
 */
function toRecurringLineResource(
  row: EmployeeRecurringLineRow | EmployeeRecurringLinePreview,
): Record<string, unknown> {
  const base = {
    item_type: row.item_type,
    description: row.description,
    amount: row.amount,
    account_number: row.account_number,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
    metadata: row.metadata,
  }
  if (row.id === null) return base
  return {
    employee_recurring_line_id: row.id,
    ...base,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const RECURRING_LINE_PITFALLS = [
  'Rows are re-derived on every :calculate for runs whose payment_date falls inside valid_from..valid_to (valid_to null = open-ended). Hand edits to a derived payslip row are overwritten by the next :calculate.',
  'The amount sign follows the item type: every supported type is a deduction and must be negative (e.g. -670.17 for a benefit bike bruttolöneavdrag). The API rejects the wrong sign with 400 VALIDATION_ERROR on field amount.',
  'account_number overrides the default BAS account for the derived payslip row; null lets the engine use its item-type mapping.',
  'Draft-only per-run edits (a one-off change on one payslip) still go through the salary-runs lines endpoints, not through recurring lines.',
]

const ListQuery = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .describe('true returns active lines only, false deactivated lines only. Default: every line.'),
})

// ──────────────────────────────────────────────────────────────────
// GET: list
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.recurring-lines.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/recurring-lines',
  summary: 'List recurring payslip lines for an employee.',
  description:
    'Returns the employee\'s standing monthly payslip rows (gross and net deductions such as a benefit bike bruttolöneavdrag, a union fee, or a net deduction for a benefit the employee pays for), newest valid_from first. Both active and deactivated lines are returned unless ?active filters them.',
  useWhen:
    'You need to see what the salary engine will derive for an employee every month, to reconcile with an HR system, or to find the employee_recurring_line_id to update or delete.',
  doNotUseFor:
    'The derived payslip rows of one run: those are on the salary run detail after :calculate. Taxable benefits in kind (bilförmån, kostförmån): use the employee benefits endpoints.',
  pitfalls: [
    ...RECURRING_LINE_PITFALLS,
    'Deactivated lines (is_active=false) are listed too: a line that a booked run derived from cannot be deleted, only deactivated, so history keeps it.',
  ],
  example: {
    response: {
      data: [
        {
          employee_recurring_line_id: 'erl_5b1c…',
          item_type: 'gross_deduction_other',
          description: 'Förmånscykel bruttolöneavdrag',
          amount: -670.17,
          account_number: null,
          valid_from: '2026-01-01',
          valid_to: null,
          is_active: true,
          metadata: {},
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: listEnvelope(RecurringLine), errorCodes: ['EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR'] },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.recurring-lines.list',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const url = new URL(request.url)
    const parsed = ListQuery.safeParse({ active: url.searchParams.get('active') ?? undefined })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await listEmployeeRecurringLines(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      isActive: parsed.data.active === undefined ? undefined : parsed.data.active === 'true',
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    return ok(result.data.map(toRecurringLineResource), { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: create
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.recurring-lines.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/employees/:id/recurring-lines',
  summary: 'Create a recurring payslip line for an employee.',
  description:
    'Adds a standing monthly payslip row. From the next :calculate on, every salary run whose payment_date falls inside valid_from..valid_to derives a payslip line from it, with flags (taxable, avgift basis, gross vs net deduction) fixed by item_type. Amounts are kept to whole öre. Requires an Idempotency-Key header.',
  useWhen:
    'An employee starts a benefit bike bruttolöneavdrag, a union fee, a monthly net deduction for a benefit they pay for, or any other deduction that repeats every month until further notice.',
  doNotUseFor:
    'One-off deductions on a single payslip: add a line on the salary run instead. Additions (a monthly allowance paid in cash): not supported as recurring lines; add them per run. Taxable benefits in kind: use the employee benefits endpoints.',
  pitfalls: [
    ...RECURRING_LINE_PITFALLS,
    'valid_to must be on or after valid_from (inclusive); omit it for an open-ended line.',
    'Creating a line does not recompute an open salary run: call POST /salary-runs/{id}/calculate afterwards.',
  ],
  example: {
    request: {
      item_type: 'gross_deduction_other',
      description: 'Förmånscykel bruttolöneavdrag',
      amount: -670.17,
      valid_from: '2026-01-01',
    },
    response: {
      data: {
        employee_recurring_line_id: 'erl_5b1c…',
        item_type: 'gross_deduction_other',
        description: 'Förmånscykel bruttolöneavdrag',
        amount: -670.17,
        account_number: null,
        valid_from: '2026-01-01',
        valid_to: null,
        is_active: true,
        metadata: {},
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateEmployeeRecurringLineSchema },
  response: { success: dataEnvelope(RecurringLine), errorCodes: ['EMPLOYEE_NOT_FOUND', 'VALIDATION_ERROR'] },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.recurring-lines.create',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = CreateEmployeeRecurringLineSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await createEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      userId: ctx.userId,
      input: parsed.data,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const payload = toRecurringLineResource(result.data)
    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return created(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
