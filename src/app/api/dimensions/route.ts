/**
 * GET /api/dimensions: the dimension registry (kostnadsställe/projekt + custom
 * dims) with nested values, for the register page and pickers.
 *
 * Calls ensure_company_dimensions first so the system dims (1 = Kostnadsställe,
 * 6 = Projekt) always exist: lazy seeding keeps core zero-config for companies
 * that never touch dimensions.
 *
 * Response contract (PR2: the register UI builds against this exactly):
 *   200 { dimensions: [{ id, sie_dim_no, name, resets_annually, is_system,
 *         is_active, sort_order, values: [{ id, code, name, is_active,
 *         start_date, end_date }] }] }
 * Dimensions sorted by sort_order, values by code.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateDimensionSchema } from '@/lib/api/schemas'
import { createDimension, listDimensions } from '@/lib/dimensions/registry-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const GET = withRouteContext(
  'dimension.list',
  async (_request, ctx) => {
    // dimensions_enabled is deliberately NOT enforced here: it is a
    // UI-visibility flag only. Agents/MCP and SIE import must operate on the
    // registry regardless of the toggle; the security boundary is company
    // scoping (withRouteContext + RLS).
    const { supabase, companyId, user, log, requestId } = ctx
    const outcome = await listDimensions({ supabase, companyId, userId: user.id, log })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json(outcome.preview)
    return NextResponse.json({ dimensions: outcome.data.dimensions })
  },
)

/**
 * POST /api/dimensions: create a custom dimension (dimensions PR10). The
 * rules (next free number from 20, explicit numbers must be unused, parent
 * must exist) live in lib/dimensions/registry-service.ts, shared with the v1
 * operation dimensions.create and gnubok_create_dimension.
 */
export const POST = withRouteContext(
  'dimension.create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, CreateDimensionSchema)
    if (!validation.success) return validation.response

    const outcome = await createDimension({ supabase, companyId, userId: user.id, log }, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: { dimension: outcome.data.dimension } }, { status: 201 })
  },
  { requireWrite: true },
)
