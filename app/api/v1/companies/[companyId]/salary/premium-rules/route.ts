/**
 * /api/v1/companies/{companyId}/salary/premium-rules
 *
 * GET  : list OB / overtime premium rules (active by default).
 * POST : create a rule. Idempotency-Key recommended; dry-runnable.
 *
 * The rules feed the shift-premium engine (lib/salary/shift-premium-engine.ts)
 * that runs inside every salary calculation: for each worked day with a
 * start and end time, every minute is awarded to the highest-priority
 * matching rule and paid as base hourly rate x hours x premium_percent.
 * Same service as the dashboard settings panel (lib/salary/shift-premium-rules.ts).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateShiftPremiumRuleSchema, ShiftPremiumItemTypeSchema } from '@/lib/api/schemas'
import type { ShiftPremiumRule } from '@/types'
import {
  createShiftPremiumRule,
  findForeignEmployeeIds,
  listShiftPremiumRules,
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
  premium_percent: z.number(),
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
    premium_percent: rule.premium_percent,
    item_type: rule.item_type,
    priority: rule.priority,
    is_active: rule.is_active,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  }
}

const EXAMPLE_RULE = {
  premium_rule_id: 'c3f2…',
  name: 'OB natt',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time: '22:00',
  end_time: '06:00',
  premium_percent: 70,
  item_type: 'ob_night',
  priority: 10,
  is_active: true,
  created_at: '2026-09-11T08:00:00Z',
  updated_at: '2026-09-11T08:00:00Z',
}

registerEndpoint({
  operation: 'salary.premium-rules.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/salary/premium-rules',
  summary: 'List OB and overtime premium rules.',
  description:
    'Returns the shift premium rules the salary engine applies to worked days (OB-tillägg for evenings, nights, weekends and public holidays; tiered overtime). Active rules only unless ?include_inactive=true. No pagination: a company has a handful of rules.',
  useWhen:
    'You want to verify how OB or overtime will be derived before calculating a run, or to mirror a kollektivavtal into the company configuration.',
  doNotUseFor:
    'The derived premium amounts on a payslip (GET /salary-runs/{id}/employees/{employeeId} after :calculate). Worked hours themselves (the worked-days register on the dashboard).',
  pitfalls: [
    'Rules only fire for worked days that carry start_time and end_time; hours-only rows are treated as 08:00-17:00 and never match night or weekend windows.',
    'Overlapping rules never double-pay: each minute goes to the highest priority, ties to the higher percent.',
    'ob_holiday rules fire only on actual Swedish public holidays, not on ordinary Sundays.',
  ],
  example: {
    response: { data: [EXAMPLE_RULE], meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'payroll:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
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
    'Adds a rule: weekdays (ISO 1-7), a wall-clock window (end <= start wraps midnight), a premium percent of the base hourly rate, one of six item types, a priority for overlaps, and a scope (all employees or a named list). Every named employee must belong to the company. Supports ?dry_run=true.',
  useWhen:
    'Configuring OB and overtime from a kollektivavtal for the first time, or adding a window the agreement defines (e.g. weekday evening 18:00-22:00 at 50 %).',
  doNotUseFor:
    'One-off manual premium lines on a single payslip (add a line on the run instead). Mertid or kompensationsledighet (not modelled).',
  pitfalls: [
    'applies_to_all_employees=true requires an empty applies_to_employee_ids; false requires at least one id. Mixed input returns 400 VALIDATION_ERROR.',
    'An employee id from another company returns 404 SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND with the offending ids in details.',
    'Percent is of the base hourly rate (monthly salary / hourly divisor for monthly staff), not an absolute amount.',
    'New rules apply to the next calculation of any open run; booked runs are never recomputed.',
  ],
  example: {
    request: {
      name: 'OB natt',
      day_of_week: [1, 2, 3, 4, 5, 6, 7],
      start_time: '22:00',
      end_time: '06:00',
      premium_percent: 70,
      item_type: 'ob_night',
      priority: 10,
      applies_to_all_employees: true,
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
    errorCodes: ['VALIDATION_ERROR', 'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND'],
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
      // Same employee check as the real write, so a dry run reports the
      // foreign-id case too.
      const foreign = await findForeignEmployeeIds(
        ctx.supabase,
        ctx.companyId!,
        body.applies_to_employee_ids,
      )
      if (!foreign.ok) {
        return v1ErrorResponseFromCode(foreign.code, ctx.log, { requestId: ctx.requestId })
      }
      if (foreign.data.length > 0) {
        return v1ErrorResponseFromCode('SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { missing_employee_ids: foreign.data },
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
)
