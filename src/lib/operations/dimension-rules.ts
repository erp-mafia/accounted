/**
 * Account dimension rule operations: which accounts require, pre-fill or
 * pin a dimension value (account_dimension_rules). Before these, rules were
 * set only in the dashboard's account dialog, so an API customer or agent
 * could neither see why a booking was refused with
 * MANDATORY_DIMENSION_MISSING nor set the policy up. The rules live in
 * lib/dimensions/rules-service.ts, shared with the dashboard routes
 * /api/dimensions/rules; the request schemas are the dashboard's own.
 */
import { z } from 'zod'
import {
  CreateAccountDimensionRuleSchema,
  ListDimensionRulesQuerySchema,
  UpdateAccountDimensionRuleSchema,
} from '@/lib/api/schemas'
import { DIMENSION_RULE_TYPES } from '@/lib/dimensions/rule-value'
import {
  createAccountDimensionRule,
  deleteAccountDimensionRule,
  listAccountDimensionRules,
  updateAccountDimensionRule,
} from '@/lib/dimensions/rules-service'
import { defineOperation } from './types'

const Rule = z.object({
  account_dimension_rule_id: z.string().uuid(),
  account_number: z.string(),
  dimension_id: z.string().uuid(),
  sie_dim_no: z.number().int(),
  dimension_name: z.string(),
  rule_type: z.enum(DIMENSION_RULE_TYPES),
  value_id: z.string().uuid().nullable().describe('The dimension value a default or fixed rule applies; null for required.'),
  value_code: z.string().nullable(),
  value_name: z.string().nullable(),
  is_active: z.boolean(),
})

const RULE_ID = z.string().uuid().describe('The rule id (account_dimension_rule_id from the rule list).')

const RULE_EXAMPLE = {
  account_dimension_rule_id: '5b7e…',
  account_number: '4010',
  dimension_id: '0e9c…',
  sie_dim_no: 6,
  dimension_name: 'Projekt',
  rule_type: 'required',
  value_id: null,
  value_code: null,
  value_name: null,
  is_active: true,
}
const META = { request_id: 'req_…', api_version: '2026-05-12' }
const RULES_PATH = '/api/v1/companies/:companyId/dimensions/rules'
const RULE_PATH = '/api/v1/companies/:companyId/dimensions/rules/:id'

const RULE_TYPE_SV: Record<string, string> = { required: 'obligatorisk', default: 'förval', fixed: 'låst' }

export const dimensionRulesList = defineOperation({
  id: 'dimension-rules.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the account dimension rules (required, default or fixed dimension per account).',
    description:
      'Returns the company\'s per-account dimension policy, by account number: required (the account cannot be posted without a value for the dimension; the booking answers MANDATORY_DIMENSION_MISSING), default (the value is filled in on a line that has none) and fixed (the value always applies, over what the line says). Paused rules (is_active false) are listed too; they are not enforced.',
    useWhen:
      'A booking was refused with MANDATORY_DIMENSION_MISSING, or before posting to an account, to know which dimensions its lines need.',
    doNotUseFor: 'The dimensions and their values themselves (GET /dimensions).',
    pitfalls: [
      'account_number filters on one exact account: a STRING of 4 digits, "4010".',
      'A company without rules gets an empty list: dimensions are then never required.',
    ],
    example: { response: { data: { rules: [RULE_EXAMPLE] }, meta: META } },
  },
  input: ListDimensionRulesQuerySchema,
  output: z.object({ rules: z.array(Rule) }),
  http: { method: 'GET', path: RULES_PATH },
  mcp: {
    name: 'gnubok_list_dimension_rules',
    title: 'List Account Dimension Rules',
    description:
      'List which accounts require a dimension (kostnadsställe, projekt) or pre-fill or pin a value: the policy behind MANDATORY_DIMENSION_MISSING. Filter by account_number.',
    keywords: ['dimensionsregel', 'obligatorisk dimension', 'kontoregel', 'kräver projekt', 'kräver kostnadsställe'],
  },
  run: (ctx, input) => listAccountDimensionRules(ctx, input),
})

export const dimensionRulesCreate = defineOperation({
  id: 'dimension-rules.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Require, pre-fill or pin a dimension value on an account.',
    description:
      'Adds a rule for one account and one dimension. required: posting the account without a value for the dimension is refused (MANDATORY_DIMENSION_MISSING), drafts may still be incomplete. default: value_id is filled in on a line of the account that carries no value for the dimension. fixed: value_id always applies, over what the line says. Takes effect for bookings from now on; posted verifikat are never changed. Idempotent. Dry-runnable.',
    useWhen:
      'Every booking on an account should carry a project or cost centre, or an account always belongs to the same one.',
    doNotUseFor: 'Tagging lines that are already posted: a rule only acts on bookings made after it.',
    pitfalls: [
      'required takes no value_id; default and fixed must name one (400 VALIDATION_ERROR otherwise).',
      'value_id must be an active value of that same dimension: 404 DIMENSION_VALUE_NOT_FOUND or 400 DIMENSION_VALUE_ARCHIVED.',
      'The account must be an active account in the chart: 404 ACCOUNT_NOT_FOUND.',
      'One rule per account and dimension: a second answers 409 DIMENSION_RULE_EXISTS; change the existing rule with PATCH instead.',
    ],
    example: {
      request: { account_number: '4010', dimension_id: '0e9c…', rule_type: 'required' },
      response: { data: { rule: RULE_EXAMPLE }, meta: META },
    },
  },
  input: CreateAccountDimensionRuleSchema,
  output: z.object({ rule: Rule }),
  errorCodes: [
    'DIMENSION_NOT_FOUND',
    'DIMENSION_VALUE_NOT_FOUND',
    'DIMENSION_VALUE_ARCHIVED',
    'ACCOUNT_NOT_FOUND',
    'DIMENSION_RULE_EXISTS',
  ],
  http: { method: 'POST', path: RULES_PATH },
  mcp: {
    name: 'gnubok_create_dimension_rule',
    title: 'Create Account Dimension Rule',
    description:
      'Stage a rule that an account requires a dimension (e.g. projekt on 4010), or pre-fills (default) or pins (fixed) a value. Applies to bookings from approval on. One rule per account and dimension.',
    keywords: ['dimensionsregel', 'kräv projekt', 'kräv kostnadsställe', 'förval dimension', 'låst dimension'],
    stage: {
      pendingType: 'create_dimension_rule',
      title: (input) =>
        `Dimensionsregel för konto ${String(input.account_number)}: ${RULE_TYPE_SV[String(input.rule_type)] ?? String(input.rule_type)}`,
    },
  },
  run: (ctx, input, { dryRun }) => createAccountDimensionRule(ctx, input, { dryRun }),
})

export const dimensionRulesUpdate = defineOperation({
  id: 'dimension-rules.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Change, pause or resume an account dimension rule.',
    description:
      'Sparse update of a rule: rule_type, value_id and is_active (false pauses the rule without losing it). The value rule holds for the rule as it will be: switching to required needs value_id null in the same call, switching to default or fixed needs a value. The account and the dimension of a rule are fixed: delete it and create another to move it. Idempotent. Dry-runnable.',
    useWhen: 'A rule should apply another value, change type, or stop being enforced for a while.',
    doNotUseFor: 'Removing a rule for good (DELETE /dimensions/rules/{id}).',
    pitfalls: [
      'At least one of rule_type, value_id, is_active must be sent.',
      'A rule of another company answers 404 DIMENSION_RULE_NOT_FOUND.',
    ],
    example: {
      request: { is_active: false },
      response: { data: { rule: { ...RULE_EXAMPLE, is_active: false } }, meta: META },
    },
  },
  input: z
    .object({ account_dimension_rule_id: RULE_ID, ...UpdateAccountDimensionRuleSchema.shape })
    .refine((b) => b.rule_type !== undefined || b.value_id !== undefined || b.is_active !== undefined, {
      message: 'Send at least one of rule_type, value_id, is_active.',
    }),
  output: z.object({ rule: Rule }),
  errorCodes: ['DIMENSION_RULE_NOT_FOUND', 'DIMENSION_VALUE_NOT_FOUND', 'DIMENSION_VALUE_ARCHIVED'],
  http: { method: 'PATCH', path: RULE_PATH, pathParams: { id: 'account_dimension_rule_id' } },
  mcp: {
    name: 'gnubok_update_dimension_rule',
    title: 'Update Account Dimension Rule',
    description:
      'Stage a change to an account dimension rule: its type, its value, or pausing it (is_active=false). Get the id from gnubok_list_dimension_rules.',
    keywords: ['ändra dimensionsregel', 'pausa dimensionsregel'],
    stage: { pendingType: 'update_dimension_rule', title: () => 'Ändra dimensionsregel' },
  },
  run: (ctx, { account_dimension_rule_id, ...changes }, { dryRun }) =>
    updateAccountDimensionRule(ctx, account_dimension_rule_id, changes, { dryRun }),
})

export const dimensionRulesDelete = defineOperation({
  id: 'dimension-rules.delete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Delete an account dimension rule.',
    description:
      'Removes the rule: from then on the account neither requires nor fills in that dimension. Nothing booked changes. Pausing it instead keeps the configuration (PATCH is_active=false). Idempotent. Dry-runnable.',
    useWhen: 'A rule no longer applies.',
    doNotUseFor: 'A short pause (PATCH is_active=false).',
    pitfalls: ['A rule of another company, or one already deleted, answers 404 DIMENSION_RULE_NOT_FOUND.'],
    example: { response: { data: { deleted: true, account_dimension_rule_id: '5b7e…' }, meta: META } },
  },
  input: z.object({ account_dimension_rule_id: RULE_ID }),
  output: z.object({ deleted: z.literal(true), account_dimension_rule_id: z.string().uuid() }),
  errorCodes: ['DIMENSION_RULE_NOT_FOUND'],
  http: { method: 'DELETE', path: RULE_PATH, pathParams: { id: 'account_dimension_rule_id' } },
  mcp: {
    name: 'gnubok_delete_dimension_rule',
    title: 'Delete Account Dimension Rule',
    description:
      'Stage deleting an account dimension rule: the account stops requiring or filling in that dimension. Nothing booked changes. Pause it instead with gnubok_update_dimension_rule (is_active=false).',
    keywords: ['ta bort dimensionsregel'],
    stage: { pendingType: 'delete_dimension_rule', title: () => 'Ta bort dimensionsregel' },
  },
  run: (ctx, { account_dimension_rule_id }, { dryRun }) =>
    deleteAccountDimensionRule(ctx, account_dimension_rule_id, { dryRun }),
})
