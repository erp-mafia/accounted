/**
 * /api/v1/companies/{companyId}/employees/{id}/recurring-lines/{lineId}
 *
 * PATCH  : update a recurring line (amount, description, validity, account,
 *          is_active, metadata). item_type is not patchable: the sign rule
 *          and the derived payslip flags key off it, so changing kind means
 *          delete + recreate.
 * DELETE : remove the line, or deactivate it when a salary run has already
 *          derived a payslip row from it (the FK keeps the provenance link).
 *
 * Both scope the row by (lineId, employee, company) so a lineId under
 * another employee or company answers 404 instead of silently mutating.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { RecurringLineItemTypeSchema, UpdateEmployeeRecurringLineSchema } from '@/lib/api/schemas'
import {
  deleteEmployeeRecurringLine,
  updateEmployeeRecurringLine,
  type EmployeeRecurringLineRow,
  type UpdateEmployeeRecurringLineInput,
} from '@/lib/salary/employee-recurring-lines'

// Repeated from ../route.ts: route files may only export HTTP handlers.
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

function toRecurringLineResource(row: EmployeeRecurringLineRow): Record<string, unknown> {
  return {
    employee_recurring_line_id: row.id,
    item_type: row.item_type,
    description: row.description,
    amount: row.amount,
    account_number: row.account_number,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    is_active: row.is_active,
    metadata: row.metadata,
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

function parsePathIds(
  id: string,
  lineId: string,
): { ok: true; employeeId: string; lineId: string } | { ok: false; field: string } {
  const employeeParse = z.string().uuid().safeParse(id)
  if (!employeeParse.success) return { ok: false, field: 'id' }
  const lineParse = z.string().uuid().safeParse(lineId)
  if (!lineParse.success) return { ok: false, field: 'lineId' }
  return { ok: true, employeeId: employeeParse.data, lineId: lineParse.data }
}

// ──────────────────────────────────────────────────────────────────
// PATCH: update
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.recurring-lines.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/employees/:id/recurring-lines/:lineId',
  summary: 'Update a recurring payslip line.',
  description:
    'Patches description, amount, account_number, valid_from, valid_to, is_active or metadata on a recurring line. The amount sign is re-checked against the stored item_type and the validity period against the merged (stored + patched) dates. item_type cannot change: delete and recreate instead. Requires an Idempotency-Key header.',
  useWhen:
    'The monthly deduction changed (new bike lease amount), the line ends on a known date (set valid_to), or it should pause without losing history (is_active=false).',
  doNotUseFor:
    'Changing the kind of line (gross to net deduction): DELETE and POST a new one. Fixing one payslip only: edit the salary run line instead.',
  pitfalls: [
    ...RECURRING_LINE_PITFALLS,
    'A patch that leaves valid_to before valid_from on the merged row is rejected with 400 VALIDATION_ERROR on field valid_to; send valid_to: null to make the line open-ended again.',
    'Runs already calculated keep their derived rows until they are recalculated; booked runs are never touched.',
  ],
  example: {
    request: { amount: -700, valid_to: '2026-12-31' },
    response: {
      data: {
        employee_recurring_line_id: 'erl_5b1c…',
        item_type: 'gross_deduction_other',
        description: 'Förmånscykel bruttolöneavdrag',
        amount: -700,
        account_number: null,
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
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
  request: { body: UpdateEmployeeRecurringLineSchema },
  response: { success: dataEnvelope(RecurringLine), errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string; lineId: string }> }>(
  'employees.recurring-lines.update',
  async (request, ctx, params) => {
    const { id, lineId } = await params.params
    const ids = parsePathIds(id, lineId)
    if (!ids.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: ids.field, message: 'Path ids must be UUIDs.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = UpdateEmployeeRecurringLineSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    // Only fields the caller actually sent: an absent key must never reach
    // the module as an explicit undefined-to-null write.
    const patch: UpdateEmployeeRecurringLineInput = {}
    for (const [key, value] of Object.entries(parsed.data) as Array<
      [keyof UpdateEmployeeRecurringLineInput, unknown]
    >) {
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value
    }
    if (Object.keys(patch).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one updatable field is required.' },
      })
    }

    const result = await updateEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: ids.employeeId,
      lineId: ids.lineId,
      patch,
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
    return ok(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: remove or deactivate
// ──────────────────────────────────────────────────────────────────

const DeleteResponse = z.object({
  employee_recurring_line_id: z.string().uuid(),
  /** true: the row is gone. false: a run had derived from it, so it was deactivated instead. */
  deleted: z.boolean(),
  deactivated: z.literal(true).optional(),
})

registerEndpoint({
  operation: 'employees.recurring-lines.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/employees/:id/recurring-lines/:lineId',
  summary: 'Delete a recurring payslip line, or deactivate it if a run already used it.',
  description:
    'Removes the line when no salary run has derived a payslip row from it. Once a run has (the derived row references the line), the database refuses the delete and the line is deactivated instead (is_active=false): the payslip row keeps its provenance, the next :calculate of a draft run drops the derived row, and nothing is re-derived. Returns 200 with deleted: true or deleted: false + deactivated: true so the caller knows which happened. Requires an Idempotency-Key header.',
  useWhen:
    'The deduction ends and there is no end date to keep (a union fee stops, the bike lease is returned), or the line was created by mistake.',
  doNotUseFor:
    'Ending a line on a future date: PATCH valid_to instead, so the remaining months still derive. Removing a derived row from one draft payslip: DELETE the salary run line.',
  pitfalls: [
    ...RECURRING_LINE_PITFALLS,
    'deleted: false with deactivated: true is a success, not an error: a run already derived from the line, so it is kept for history and switched off.',
    'A lineId under another employee or company answers 404 NOT_FOUND.',
  ],
  example: {
    response: {
      data: { employee_recurring_line_id: 'erl_5b1c…', deleted: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(DeleteResponse), errorCodes: ['NOT_FOUND'] },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string; lineId: string }> }>(
  'employees.recurring-lines.delete',
  async (_request, ctx, params) => {
    const { id, lineId } = await params.params
    const ids = parsePathIds(id, lineId)
    if (!ids.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: ids.field, message: 'Path ids must be UUIDs.' },
      })
    }

    const result = await deleteEmployeeRecurringLine(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: ids.employeeId,
      lineId: ids.lineId,
      dryRun: ctx.dryRun,
    })

    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }

    const { id: rowId, ...outcome } = result.data
    const payload = { employee_recurring_line_id: rowId, ...outcome }
    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
