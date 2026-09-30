/**
 * /api/dimensions/rules — per-account dimension policy (dimensions PR10).
 *
 * GET  ?account_number=4010 (optional) → every rule (or the account's).
 * POST → create a rule. 'required' blocks posting on the account without a
 * value for the dimension (enforced at commitEntry + the bulk-book route);
 * 'default' pre-fills at draft creation; 'fixed' always applies.
 *
 * Opt-in by construction: zero rules = the engine behaves exactly as before.
 * There is deliberately NO settings toggle for enforcement — a rule that
 * exists but is ignored would be worse than either extreme; pausing a single
 * rule is what is_active is for.
 *
 * The rules live in lib/dimensions/rules-service.ts, shared with the v1
 * operations dimension-rules.* and their MCP tools.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateAccountDimensionRuleSchema, ListDimensionRulesQuerySchema } from '@/lib/api/schemas'
import { createAccountDimensionRule, listAccountDimensionRules } from '@/lib/dimensions/rules-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()


export const GET = withRouteContext(
  'dimension.rules.list',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const queryValidation = validateQuery(request, ListDimensionRulesQuerySchema, {
      log,
      operation: 'dimension.rules.list',
    })
    if (!queryValidation.success) return queryValidation.response

    const outcome = await listAccountDimensionRules(
      { supabase, companyId, userId: user.id, log },
      { account_number: queryValidation.data.account_number },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { rules: outcome.data.rules } })
  },
)

export const POST = withRouteContext(
  'dimension.rules.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, CreateAccountDimensionRuleSchema)
    if (!validation.success) return validation.response

    const outcome = await createAccountDimensionRule({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { rule: outcome.data.rule } }, { status: 201 })
  },
  { requireWrite: true },
)
