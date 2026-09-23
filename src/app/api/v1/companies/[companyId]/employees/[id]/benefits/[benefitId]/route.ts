/**
 * /api/v1/companies/{companyId}/employees/{id}/benefits/{benefitId}
 *
 * PATCH  : partial update. Mandatory Idempotency-Key. Dry-runnable: the
 *          preview is the merged row. benefit_type is not patchable.
 * DELETE : remove, 200 with the outcome. Mandatory Idempotency-Key.
 *          Dry-runnable. Mirrors the dashboard's delete: a row no payslip
 *          line derives from is hard-deleted; one that a line derives from
 *          is kept and deactivated so provenance survives (#2695).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateEmployeeBenefitSchema } from '@/lib/api/schemas'
import type { Logger } from '@/lib/logger'
import {
  EmployeeBenefitResourceSchema,
  deleteEmployeeBenefit,
  toEmployeeBenefitResource,
  updateEmployeeBenefit,
} from '@/lib/salary/employee-benefits'

type BenefitParams = { params: Promise<{ companyId: string; id: string; benefitId: string }> }

/**
 * Module failures map 1:1 onto registered codes (EMPLOYEE_NOT_FOUND,
 * NOT_FOUND, VALIDATION_ERROR, DB_PERMISSION_DENIED, INTERNAL_ERROR). A
 * module-authored validation message ({ field, message }) is rendered in the
 * same `issues` list a failed Zod parse produces, so agents read one shape.
 */
const BenefitDeleteOutcome = z.object({
  employee_benefit_id: z.string().uuid(),
  deleted: z.boolean(),
  deactivated: z.boolean(),
})

function benefitError(
  result: { code: string; details?: Record<string, unknown> },
  log: Logger,
  requestId: string,
) {
  const details = result.details
  const rendered =
    result.code === 'VALIDATION_ERROR' && details && typeof details.field === 'string'
      ? { issues: [{ field: details.field, message: String(details.message) }] }
      : details
  return v1ErrorResponseFromCode(result.code, log, { requestId, details: rendered })
}

/** Both path ids must be UUIDs before they touch the database or an error body. */
function parseIds(
  raw: { id: string; benefitId: string },
  ctx: { log: Logger; requestId: string },
): { ok: true; employeeId: string; benefitId: string } | { ok: false; response: Promise<Response> } {
  const employee = z.string().uuid().safeParse(raw.id)
  if (!employee.success) {
    return {
      ok: false,
      response: v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Employee id must be a UUID.' },
      }),
    }
  }
  const benefit = z.string().uuid().safeParse(raw.benefitId)
  if (!benefit.success) {
    return {
      ok: false,
      response: v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'benefitId', message: 'Benefit id must be a UUID.' },
      }),
    }
  }
  return { ok: true, employeeId: employee.data, benefitId: benefit.data }
}

// ──────────────────────────────────────────────────────────────────
// PATCH: partial update
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.benefits.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/employees/:id/benefits/:benefitId',
  summary: 'Partially update a benefit (förmån) on an employee.',
  description:
    'Patches the supplied fields: description, monthly_value, valid_from, valid_to (null clears it), is_active, metadata, and for bike rows annual_market_value (the server re-derives monthly_value). benefit_type is not patchable: delete and recreate to change the kind. Mandatory Idempotency-Key. Dry-runnable: the preview is the merged row.',
  useWhen:
    'The förmånsvärde changes (new schablon for the year, a new bike price), the benefit ends (set valid_to), or you want to pause it without losing the row (is_active=false).',
  doNotUseFor:
    'Changing the benefit kind (delete + create). Editing the derived line on one specific run: edit the payslip line on that run instead, the register stays as is.',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'valid_from and valid_to are checked against the MERGED stored+patched pair: a valid_to-only patch that predates the stored valid_from is 400 VALIDATION_ERROR (field valid_to).',
    'annual_market_value is accepted on bike rows only (400 otherwise) and overrides any monthly_value in the same body.',
    'The förmånsvärde is added to the tax and arbetsgivaravgift basis at :calculate; a change here does not recompute an open run. Call POST /salary-runs/{id}/calculate afterwards.',
    'To stop a benefit that a calculated run already consumed, set is_active=false or valid_to here; DELETE on such a row also keeps and deactivates it rather than removing it. Either way the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695).',
  ],
  example: {
    request: { valid_to: '2026-06-30' },
    response: {
      data: {
        employee_benefit_id: 'ben_4f2a…',
        benefit_type: 'car',
        description: 'Bilförmån Volvo XC40',
        monthly_value: 4275,
        annual_market_value: null,
        valid_from: '2026-01-01',
        valid_to: '2026-06-30',
        is_active: true,
        metadata: {},
        created_at: '2026-01-05T09:12:00Z',
        updated_at: '2026-06-02T14:40:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateEmployeeBenefitSchema },
  response: { success: dataEnvelope(EmployeeBenefitResourceSchema) },
})

export const PATCH = withApiV1<BenefitParams>(
  'employees.benefits.update',
  async (request, ctx, params) => {
    const ids = parseIds(await params.params, ctx)
    if (!ids.ok) return ids.response

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = UpdateEmployeeBenefitSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (Object.keys(body).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    const result = await updateEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: ids.employeeId,
      benefitId: ids.benefitId,
      patch: body,
      dryRun: ctx.dryRun,
    })
    if (!result.ok) return benefitError(result, ctx.log, ctx.requestId)

    if (!result.data.committed) {
      return dryRunPreview(toEmployeeBenefitResource(result.data.preview), {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }
    return ok(toEmployeeBenefitResource(result.data.row), { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: hard delete, or deactivate when a payslip line derives from it
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.benefits.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/employees/:id/benefits/:benefitId',
  summary: 'Remove a benefit (förmån) from an employee.',
  description:
    'Removes the benefit from the employee, the same operation the dashboard performs. A row that no payslip line derives from is hard-deleted; a row that a calculated run already derived a line from is kept and switched off (is_active=false) so the line keeps its provenance. Answers 200 with the outcome, 404 NOT_FOUND when no such row exists on the employee. Mandatory Idempotency-Key. Dry-runnable: the preview is the row that would be removed.',
  useWhen:
    'A benefit was registered by mistake, or it ends and you do not need it listed as active any more. If it has been used by a calculated run it is deactivated rather than deleted.',
  doNotUseFor:
    'Ending a benefit on a date while keeping it active until then: PATCH valid_to. Removing the derived line from one run: edit that run\'s payslip lines.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Answers 200 with { employee_benefit_id, deleted, deactivated }. A benefit that a payslip line already derives from is never hard-deleted: it is kept and switched off (deleted=false, deactivated=true), so the chain from a booked verifikat back to its förmån stays intact (BFL 5 kap 6-7 §). A second DELETE of a gone id returns 404 NOT_FOUND; a second DELETE of a deactivated row answers deactivated=true again.',
    'Removing or deactivating a benefit does not recompute an open run: the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695). A booked run is never changed.',
  ],
  example: {
    response: {
      data: { employee_benefit_id: 'ben_9c2e…', deleted: true, deactivated: false },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(BenefitDeleteOutcome) },
})

export const DELETE = withApiV1<BenefitParams>(
  'employees.benefits.delete',
  async (_request, ctx, params) => {
    const ids = parseIds(await params.params, ctx)
    if (!ids.ok) return ids.response

    const result = await deleteEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: ids.employeeId,
      benefitId: ids.benefitId,
      dryRun: ctx.dryRun,
    })
    if (!result.ok) return benefitError(result, ctx.log, ctx.requestId)

    if (!result.data.committed) {
      return dryRunPreview(toEmployeeBenefitResource(result.data.preview), {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }
    if (!result.data.deleted && !result.data.deactivated) {
      ctx.log.warn('employees.benefits.delete: not found', {
        benefitId: ids.benefitId,
        employeeId: ids.employeeId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'employee_benefit' },
      })
    }
    return ok(
      {
        employee_benefit_id: ids.benefitId,
        deleted: result.data.deleted,
        deactivated: result.data.deactivated === true,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
