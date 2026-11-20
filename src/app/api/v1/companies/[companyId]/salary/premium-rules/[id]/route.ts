/**
 * /api/v1/companies/{companyId}/salary/premium-rules/{id}
 *
 * PATCH  : update a subset of fields. The scope pair, the amount field of the
 *          form and the validity order are checked on the merged state.
 *          Dry-runnable.
 * DELETE : remove the rule. A rule a payslip line derives from is switched off
 *          instead, so the line keeps the rule it was paid under.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateShiftPremiumRuleSchema } from '@/lib/api/schemas'
import {
  deleteShiftPremiumRule,
  getShiftPremiumRule,
  mergeShiftPremiumRuleUpdate,
  updateShiftPremiumRule,
} from '@/lib/salary/shift-premium-rules'
import { EXAMPLE_RULE, PremiumRule, toV1Rule } from '../route'

function parseRuleId(id: string) {
  return z.string().uuid().safeParse(id)
}

registerEndpoint({
  operation: 'salary.premium-rules.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/salary/premium-rules/:id',
  summary: 'Update an OB or overtime premium rule.',
  description:
    'Patches any subset of the rule fields. The scope pair, the amount field of the form and the validity order are validated on the merged state. Sending amount_form switches the form and clears the fields of the other forms, so send the new form\'s field with it. Set valid_to to end a rule on a date, or is_active=false to switch it off.',
  useWhen:
    'A kollektivavtal changed a window, or a rule should end on a date (valid_to). For a new rate from a date, end this rule and create a new one, so runs before the date keep the old rate.',
  doNotUseFor:
    'Retroactive corrections of booked runs (use the salary run correction flow, which recomputes from the dated rules).',
  pitfalls: [
    'Changing the rate in place changes it for every date the rule covers, including open runs of earlier periods; a dated step is a new rule.',
    'A field of another form without amount_form returns 400 SHIFT_PREMIUM_RULE_FORM_INVALID.',
    'Flipping applies_to_all_employees to false without applies_to_employee_ids returns 400 SHIFT_PREMIUM_RULE_SCOPE_INVALID.',
    'Named employee ids are re-verified whenever the list or the form changes.',
  ],
  example: {
    request: { valid_to: '2026-03-31' },
    response: {
      data: { ...EXAMPLE_RULE, valid_to: '2026-03-31', updated_at: '2026-10-27T09:00:00Z' },
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
      'SHIFT_PREMIUM_RULE_FORM_INVALID',
      'SHIFT_PREMIUM_RULE_VALIDITY_INVALID',
      'SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND',
      'SHIFT_PREMIUM_RULE_HOURLY_EMPLOYEE',
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
      const merged = await mergeShiftPremiumRuleUpdate(ctx.supabase, {
        companyId: ctx.companyId!,
        existing: existing.data,
        input: body,
      })
      if (!merged.ok) {
        return v1ErrorResponseFromCode(merged.code, ctx.log, {
          requestId: ctx.requestId,
          details: merged.details,
        })
      }
      return dryRunPreview(toV1Rule(merged.data.rule), { requestId: ctx.requestId, log: ctx.log })
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
  { requireIdempotencyKey: true },
)

const PremiumRuleDeletion = z.object({
  premium_rule_id: z.string().uuid(),
  deleted: z.boolean(),
  deactivated: z
    .boolean()
    .describe('True when a payslip line derives from the rule: kept and switched off instead of deleted.'),
})

registerEndpoint({
  operation: 'salary.premium-rules.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/salary/premium-rules/:id',
  summary: 'Delete an OB or overtime premium rule.',
  description:
    'Deletes a rule no payslip line derives from. A rule a calculated run already derived a line from is kept and switched off (is_active=false) instead, so the line keeps the rule it was paid under; it derives nothing on the next calculation. Answers deleted and deactivated.',
  useWhen: 'A rule was created by mistake, or it should no longer apply at all.',
  doNotUseFor: 'Ending a rule on a date while it still pays before it (PATCH valid_to).',
  pitfalls: [
    'deleted=false with deactivated=true is a success: a payslip line already derives from the rule.',
    'Returns 404 SHIFT_PREMIUM_RULE_NOT_FOUND when the id is unknown to this company.',
  ],
  example: {
    response: {
      data: { premium_rule_id: 'c3f2…', deleted: true, deactivated: false },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'payroll:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(PremiumRuleDeletion), errorCodes: ['SHIFT_PREMIUM_RULE_NOT_FOUND'] },
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
      return dryRunPreview(
        {
          ...toV1Rule(existing.data),
          note: 'A rule a payslip line derives from is kept and switched off instead of deleted.',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
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
    return ok(
      { premium_rule_id: result.data.id, deleted: result.data.deleted, deactivated: result.data.deactivated },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
