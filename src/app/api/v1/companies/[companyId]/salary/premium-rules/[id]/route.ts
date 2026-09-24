/**
 * /api/v1/companies/{companyId}/salary/premium-rules/{id}
 *
 * PATCH  : update a subset of fields. The scope pair (all employees XOR
 *          named employees) is checked on the merged state. Dry-runnable.
 * DELETE : hard delete. Rules are configuration: derived premium lines are
 *          regenerated per calculation and booked runs are immutable.
 */

import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import {
  deleteShiftPremiumRule,
  getShiftPremiumRule,
  updateShiftPremiumRule,
} from '@/lib/salary/shift-premium-rules'
import { PremiumRule, toV1Rule } from '../route'

function parseRuleId(id: string) {
  return z.string().uuid().safeParse(id)
}

registerEndpoint({
  operation: 'salary.premium-rules.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/salary/premium-rules/:id',
  summary: 'Update an OB or overtime premium rule.',
  description:
    'Patches any subset of the rule fields. The scope pair is validated on the merged state: flipping applies_to_all_employees to false without supplying applies_to_employee_ids returns 400 SHIFT_PREMIUM_RULE_SCOPE_INVALID. Set is_active=false to retire a rule without deleting it.',
  useWhen:
    'A kollektivavtal changed a percent or a window, or a rule should stop applying from the next calculation.',
  doNotUseFor:
    'Retroactive corrections of booked runs (use the salary run correction flow).',
  pitfalls: [
    'Named employee ids are re-verified against the company on every patch that sends them.',
    'Changes apply to the next calculation of an open run only.',
  ],
  example: {
    request: { premium_percent: 75 },
    response: {
      data: {
        premium_rule_id: 'c3f2…',
        name: 'OB natt',
        applies_to_all_employees: true,
        applies_to_employee_ids: [],
        day_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: '22:00',
        end_time: '06:00',
        premium_percent: 75,
        item_type: 'ob_night',
        priority: 10,
        is_active: true,
        created_at: '2026-09-11T08:00:00Z',
        updated_at: '2026-09-11T09:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateShiftPremiumRuleSchema },
  response: {
    success: dataEnvelope(PremiumRule),
    errorCodes: [
      'VALIDATION_ERROR',
      'SHIFT_PREMIUM_RULE_NOT_FOUND',
      'SHIFT_PREMIUM_RULE_SCOPE_INVALID',
      'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
    ],
  },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary.premium-rules.update',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = parseRuleId(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Premium rule id must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const parsed = UpdateShiftPremiumRuleSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (ctx.dryRun) {
      const existing = await getShiftPremiumRule(ctx.supabase, {
        companyId: ctx.companyId!,
        ruleId: idParse.data,
      })
      if (!existing.ok) {
        return v1ErrorResponseFromCode(existing.code, ctx.log, { requestId: ctx.requestId })
      }
      return dryRunPreview(toV1Rule({ ...existing.data, ...body }), {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }

    const result = await updateShiftPremiumRule(ctx.supabase, {
      companyId: ctx.companyId!,
      ruleId: idParse.data,
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

registerEndpoint({
  operation: 'salary.premium-rules.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/salary/premium-rules/:id',
  summary: 'Delete an OB or overtime premium rule.',
  description:
    'Hard-deletes the rule. Premium lines already derived on an open run are regenerated (without this rule) on its next calculation; booked runs keep their verifikat unchanged.',
  useWhen: 'A rule was created by mistake. To stop a rule while keeping its history, PATCH is_active=false instead.',
  doNotUseFor: 'Pausing a rule (PATCH is_active=false).',
  pitfalls: ['Returns 404 SHIFT_PREMIUM_RULE_NOT_FOUND when the id is unknown to this company.'],
  example: { response: { data: null } },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: false,
  reversible: false,
  dryRunSupported: true,
  response: { success: NoBodyResponse, errorCodes: ['SHIFT_PREMIUM_RULE_NOT_FOUND'] },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'salary.premium-rules.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = parseRuleId(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Premium rule id must be a UUID.' },
      })
    }

    if (ctx.dryRun) {
      const existing = await getShiftPremiumRule(ctx.supabase, {
        companyId: ctx.companyId!,
        ruleId: idParse.data,
      })
      if (!existing.ok) {
        return v1ErrorResponseFromCode(existing.code, ctx.log, { requestId: ctx.requestId })
      }
      return dryRunPreview({ premium_rule_id: idParse.data, deleted: true }, {
        requestId: ctx.requestId,
        log: ctx.log,
      })
    }

    const result = await deleteShiftPremiumRule(ctx.supabase, {
      companyId: ctx.companyId!,
      ruleId: idParse.data,
    })
    if (!result.ok) {
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }
    return noContent({ requestId: ctx.requestId })
  },
)
