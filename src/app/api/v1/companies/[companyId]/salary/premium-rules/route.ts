/**
 * /api/v1/companies/{companyId}/salary/premium-rules
 *
 * GET  : list OB / overtime premium rules (active by default).
 * POST : create a rule. Idempotency-Key recommended; dry-runnable.
 *
 * The rules feed the shift-premium engine (lib/salary/shift-premium-engine.ts)
 * that runs inside every salary calculation: for each worked day with a
 * start and end time, every minute is awarded to one matching rule and paid
 * in that rule's amount form. Same service as the dashboard settings panel
 * (lib/salary/shift-premium-rules.ts).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import {
  CreateShiftPremiumRuleSchema,
  ShiftPremiumAmountFormSchema,
  ShiftPremiumItemTypeSchema,
} from '@/lib/api/schemas'
import type { ShiftPremiumRule } from '@/types'
import {
  createShiftPremiumRule,
  listShiftPremiumRules,
  verifyNamedEmployees,
} from '@/lib/salary/shift-premium-rules'

export const PremiumRule = z.object({
  premium_rule_id: z.string().uuid(),
  name: z.string(),
  applies_to_all_employees: z.boolean(),
  applies_to_employee_ids: z.array(z.string().uuid()),
  /** ISO weekdays, 1 = Monday to 7 = Sunday. */
  day_of_week: z.array(z.number().int()),
  /** 'HH:MM'. end_time <= start_time means the window wraps past midnight. */
  start_time: z.string(),
  end_time: z.string(),
  amount_form: ShiftPremiumAmountFormSchema,
  /** percent_of_hourly only. */
  premium_percent: z.number().nullable(),
  /** monthly_divisor only: månadslön / monthly_divisor per hour. */
  monthly_divisor: z.number().nullable(),
  /** sek_per_hour only: kronor per hour. */
  sek_per_hour: z.number().nullable(),
  /** percent_of_hourly only, optional: the agreement's månadslön to timlön divisor. */
  hourly_divisor: z.number().nullable(),
  /** First date (inclusive). Null only on rules created before validity existed. */
  valid_from: z.string().nullable(),
  /** Last date (inclusive). Null = open-ended. */
  valid_to: z.string().nullable(),
  item_type: ShiftPremiumItemTypeSchema,
  priority: z.number().int(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
})

/** Public shape: qualified id, no tenant or actor columns. */
export function toV1Rule(rule: ShiftPremiumRule): z.infer<typeof PremiumRule> {
  return {
    premium_rule_id: rule.id,
    name: rule.name,
    applies_to_all_employees: rule.applies_to_all_employees,
    applies_to_employee_ids: rule.applies_to_employee_ids,
    day_of_week: rule.day_of_week,
    start_time: rule.start_time,
    end_time: rule.end_time,
    amount_form: rule.amount_form,
    premium_percent: rule.premium_percent,
    monthly_divisor: rule.monthly_divisor,
    sek_per_hour: rule.sek_per_hour,
    hourly_divisor: rule.hourly_divisor,
    valid_from: rule.valid_from,
    valid_to: rule.valid_to,
    item_type: rule.item_type,
    priority: rule.priority,
    is_active: rule.is_active,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  }
}

export const EXAMPLE_RULE = {
  premium_rule_id: 'c3f2…',
  name: 'OB kväll',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [1, 2, 3, 4, 5],
  start_time: '18:00',
  end_time: '06:00',
  amount_form: 'monthly_divisor',
  premium_percent: null,
  monthly_divisor: 480,
  sek_per_hour: null,
  hourly_divisor: null,
  valid_from: '2025-04-01',
  valid_to: null,
  item_type: 'ob_weekday_evening',
  priority: 0,
  is_active: true,
  created_at: '2026-10-27T08:00:00Z',
  updated_at: '2026-10-27T08:00:00Z',
}

const ListQuery = z.object({
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .describe('true also returns switched-off rules. Default: active only.'),
})

registerEndpoint({
  operation: 'salary.premium-rules.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary/premium-rules',
  summary: 'List OB and overtime premium rules.',
  description:
    'Returns the shift premium rules the salary engine applies to worked days (OB-tillägg for evenings, nights, weekends and public holidays; tiered overtime), each with its amount form and validity. Active rules only unless ?include_inactive=true. No pagination: a company has a handful of rules.',
  useWhen:
    'You want to verify how OB or overtime will be derived before calculating a run, or to mirror a kollektivavtal into the company configuration.',
  doNotUseFor:
    'The derived premium amounts on a payslip (GET /salary-runs/{id}/employees/{employeeId} after :calculate; each derived line names its rule). Worked hours themselves (the worked-days register).',
  pitfalls: [
    'Rules only fire for worked days that carry start_time and end_time; hours-only rows are treated as 08:00-17:00 and never match night or weekend windows.',
    'Overlapping rules never double-pay: each minute goes to the highest priority, then to the rule paying the most per hour for that employee.',
    'ob_holiday rules fire only on actual Swedish public holidays, not on ordinary Sundays.',
    'A rule pays only on dates between valid_from and valid_to; a rate step is two rules, the old one ending the day before the new one starts.',
  ],
  example: {
    response: { data: [EXAMPLE_RULE], meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: listEnvelope(PremiumRule) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary.premium-rules.list',
  async (request, ctx) => {
    const includeInactive = new URL(request.url).searchParams.get('include_inactive') === 'true'
    const result = await listShiftPremiumRules(ctx.supabase, {
      companyId: ctx.companyId!,
      includeInactive,
    })
    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }
    return ok(result.data.map(toV1Rule), { requestId: ctx.requestId })
  },
)

registerEndpoint({
  operation: 'salary.premium-rules.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/salary/premium-rules',
  summary: 'Create an OB or overtime premium rule.',
  description:
    'Adds a rule: weekdays (ISO 1-7), a wall-clock window (end <= start wraps midnight), an amount form with exactly its own field (percent_of_hourly: premium_percent of the hourly wage, optionally with the agreement hourly_divisor for monthly-paid staff, e.g. Handels 166; monthly_divisor: månadslön / monthly_divisor per hour, e.g. Almega 480/300/150 or övertid 94/72; sek_per_hour: fixed kronor per hour, e.g. Gröna riksavtalet 27.59), a validity (valid_from required, valid_to optional), one of six item types, a priority for overlaps, and a scope (all employees or a named list). Supports ?dry_run=true.',
  useWhen:
    'Configuring OB and overtime from a kollektivavtal, or entering a new rate from a date (create the new rule with valid_from and set valid_to on the old one).',
  doNotUseFor:
    'One-off manual premium lines on a single payslip (put the amount on item_type overtime or other on the run instead). Mertid or kompensationsledighet (not modelled).',
  pitfalls: [
    'Send only the field of the chosen form: a percent on a monthly_divisor rule returns 400 VALIDATION_ERROR naming premium_percent.',
    'monthly_divisor prices from the månadslön: OB types use the actual (degree-adjusted) salary, övertid types the full-time salary. It does not apply to hourly-paid employees, and naming one returns 400 SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE.',
    'applies_to_all_employees=true requires an empty applies_to_employee_ids; false requires at least one id.',
    'An employee id from another company returns 404 SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND with the offending ids in details.',
    'For "no OB on overtime hours" give the övertid rules a higher priority than the OB rules on the same window; at equal priority the rule paying the most per hour wins.',
    'New rules apply to the next calculation of any open run; booked runs are never recomputed.',
  ],
  example: {
    request: {
      name: 'OB kväll',
      day_of_week: [1, 2, 3, 4, 5],
      start_time: '18:00',
      end_time: '06:00',
      amount_form: 'monthly_divisor',
      monthly_divisor: 480,
      valid_from: '2025-04-01',
      item_type: 'ob_weekday_evening',
    },
    response: { data: EXAMPLE_RULE, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateShiftPremiumRuleSchema },
  response: {
    success: dataEnvelope(PremiumRule),
    errorCodes: ['VALIDATION_ERROR', 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND', 'SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'salary.premium-rules.create',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = CreateShiftPremiumRuleSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (ctx.dryRun) {
      // Same employee checks as the real write, so a dry run reports a
      // foreign or hourly-paid employee too.
      const employeesOk = await verifyNamedEmployees(ctx.supabase, {
        companyId: ctx.companyId!,
        amountForm: body.amount_form,
        employeeIds: body.applies_to_employee_ids,
      })
      if (!employeesOk.ok) {
        return v1ErrorResponseFromCode(employeesOk.code, ctx.log, {
          requestId: ctx.requestId,
          details: employeesOk.details,
        })
      }
      return dryRunPreview(body, { requestId: ctx.requestId, log: ctx.log })
    }

    const result = await createShiftPremiumRule(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      input: body,
    })
    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }
    return ok(toV1Rule(result.data), { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
