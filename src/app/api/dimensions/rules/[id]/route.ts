/**
 * /api/dimensions/rules/[id] — mutate one account dimension rule (PR10).
 *
 * PATCH  { rule_type?, value_id?, is_active? } — value presence is
 *        re-validated against the EFFECTIVE rule_type (required ⇔ no value).
 * DELETE — removes the rule; enforcement stops immediately. Pausing without
 *          losing the configuration is is_active: false.
 *
 * The rules live in lib/dimensions/rules-service.ts, shared with the v1
 * operations dimension-rules.* and their MCP tools.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateAccountDimensionRuleSchema } from '@/lib/api/schemas'
import { deleteAccountDimensionRule, updateAccountDimensionRule } from '@/lib/dimensions/rules-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'dimension.rules.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, UpdateAccountDimensionRuleSchema)
    if (!validation.success) return validation.response

    const outcome = await updateAccountDimensionRule({ supabase, companyId, userId: user.id, log }, id, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { rule: outcome.data.rule } })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'dimension.rules.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    const outcome = await deleteAccountDimensionRule({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
