/**
 * /api/v1/companies/{companyId}/employees/{id}/benefits
 *
 * GET  : list the employee's benefit rows (förmåner), active and inactive,
 *        newest validity window first. Optional ?active=true|false.
 * POST : register a benefit. Mandatory Idempotency-Key. Dry-runnable.
 *
 * A benefit row is a standing monthly förmånsvärde that the calculation
 * engine (lib/salary/run-calculation.ts, step 8d) turns into one taxable,
 * avgift-bearing payslip line per run whose payment_date falls inside
 * [valid_from, valid_to]. Bike is the only type the server computes
 * (annual_market_value to monthly_value per Skatteverket schablon); every
 * other type, bilförmån included, is stored as the schablon value the
 * caller supplies.
 */

import { z } from 'zod'
import { created, ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateEmployeeBenefitSchema } from '@/lib/api/schemas'
import type { Logger } from '@/lib/logger'
import {
  EmployeeBenefitResourceSchema,
  createEmployeeBenefit,
  listEmployeeBenefits,
  toEmployeeBenefitPreviewResource,
  toEmployeeBenefitResource,
} from '@/lib/salary/employee-benefits'

/**
 * Module failures map 1:1 onto registered codes (EMPLOYEE_NOT_FOUND,
 * NOT_FOUND, VALIDATION_ERROR, DB_PERMISSION_DENIED, INTERNAL_ERROR). A
 * module-authored validation message ({ field, message }) is rendered in the
 * same `issues` list a failed Zod parse produces, so agents read one shape.
 */
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

const ListQuery = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .describe('true returns only rows with is_active=true, false only inactive rows. Default: both.'),
})

registerEndpoint({
  operation: 'employees.benefits.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/employees/:id/benefits',
  summary: 'List the benefits (förmåner) registered on an employee.',
  description:
    'Returns every benefit row on the employee, active and inactive, newest validity window first (valid_from descending, then created_at). Optional ?active=true|false filter. No cursor pagination: an employee carries a handful of rows.',
  useWhen:
    'You need to see which förmåner the salary engine will derive for an employee (bilförmån, kostförmån, cykelförmån, bostad, friskvård, annat), reconcile against an HR system, or find the employee_benefit_id to update or remove.',
  doNotUseFor:
    'The derived payslip line and its tax effect: that lives on the salary run after :calculate. Standing deductions (bruttolöneavdrag, fackavgift): the recurring-lines register.',
  pitfalls: [
    'The monthly förmånsvärde is added to the tax and arbetsgivaravgift basis when a run is calculated (POST /salary-runs/{id}/calculate); it is never paid out.',
    'A run picks a row up when is_active is true and valid_from <= payment_date <= valid_to (valid_to null = open-ended). Rows outside that window are listed here but derive nothing.',
    'annual_market_value is populated for bike benefits only (read from the stored calculation inputs); other types carry null.',
  ],
  example: {
    response: {
      data: [
        {
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
  response: { success: listEnvelope(EmployeeBenefitResourceSchema) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.benefits.list',
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

    const result = await listEmployeeBenefits(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      active: parsed.data.active === undefined ? undefined : parsed.data.active === 'true',
    })
    if (!result.ok) return benefitError(result, ctx.log, ctx.requestId)

    return ok(result.data.map(toEmployeeBenefitResource), { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: create
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'employees.benefits.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/employees/:id/benefits',
  summary: 'Register a benefit (förmån) on an employee.',
  description:
    'Creates a standing monthly förmånsvärde row. benefit_type is one of bike, car, meals, housing, wellness, other. Every type except bike takes monthly_value: the schablon value you already know. bike takes annual_market_value and the server derives monthly_value = max(0, annual_market_value - 3000) / 12 (Skatteverket schablon, 3 000 kr/year tax-free), storing the inputs in metadata. Mandatory Idempotency-Key. Dry-runnable: the preview is the row that would be inserted, with the derived values.',
  useWhen:
    '"Anna gets a company car from January": register the schablon value once and every run inside the window derives the line. Also when migrating an employee register from another payroll system.',
  doNotUseFor:
    'Computing a bilförmån from the car (nybilspris, miljöbil, fordonsskatt): do that with Skatteverket\'s calculator and send the result. Standing deductions such as a bruttolöneavdrag for the same car: the recurring-lines register. One-off taxable additions: edit the payslip lines on the run.',
  pitfalls: [
    'The förmånsvärde is added to the employee\'s tax and arbetsgivaravgift basis when the run is calculated (POST /salary-runs/{id}/calculate): skatteavdrag and avgifter go up, nothing is paid out. Registering a benefit does not recompute an open run; call :calculate afterwards.',
    'car (bilförmån) is supplied as the monthly schablon value you computed (Skatteverket\'s bilförmånsberäkning, including miljöbil and 30 000 km reductions); the API does not compute it from the car.',
    'bike takes annual_market_value, not monthly_value: the server derives the monthly value with the 3 000 kr/year tax-free allowance. A monthly_value sent next to annual_market_value on a bike row is ignored.',
    'valid_from / valid_to gate which runs pick the row up: a run derives the line when valid_from <= payment_date <= valid_to (valid_to omitted = open-ended). Both dates are inclusive; valid_to before valid_from is 400 VALIDATION_ERROR.',
    'To stop a benefit that already fed a calculated run, PATCH is_active=false or set valid_to; DELETE on such a row keeps and deactivates it rather than removing it. Either way the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695).',
  ],
  example: {
    request: {
      benefit_type: 'bike',
      description: 'Cykelförmån',
      annual_market_value: 15000,
      valid_from: '2026-03-01',
    },
    response: {
      data: {
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
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateEmployeeBenefitSchema },
  response: { success: dataEnvelope(EmployeeBenefitResourceSchema) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'employees.benefits.create',
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

    const parsed = CreateEmployeeBenefitSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const result = await createEmployeeBenefit(ctx.supabase, {
      companyId: ctx.companyId!,
      employeeId: idParse.data,
      userId: ctx.userId,
      input: parsed.data,
      dryRun: ctx.dryRun,
    })
    if (!result.ok) return benefitError(result, ctx.log, ctx.requestId)

    if (!result.data.committed) {
      return dryRunPreview(toEmployeeBenefitPreviewResource(result.data.preview), {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }
    return created(toEmployeeBenefitResource(result.data.row), { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
