/**
 * /api/v1/companies/{companyId}/dimensions/rules: account dimension rules.
 *
 * GET  : list the rules (operation dimension-rules.list).
 * POST : require, pre-fill or pin a dimension on an account
 *        (operation dimension-rules.create).
 *
 * Contracts, docs and rules live in src/lib/operations/dimension-rules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dimensionRulesCreate, dimensionRulesList } from '@/lib/operations/dimension-rules'

export const GET = v1OperationHandler(dimensionRulesList)
export const POST = v1OperationHandler(dimensionRulesCreate)
