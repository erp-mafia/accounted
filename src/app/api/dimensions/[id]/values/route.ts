/**
 * POST /api/dimensions/[id]/values: create a dimension value (SIE #OBJEKT).
 *
 * Codes are validated against the strict Fortnox format
 * (^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$) for user-created values: the DB CHECK is
 * looser by design so legacy free-text codes survive the backfill/SIE import,
 * but new registry codes minted here stay portable. Duplicate codes within the
 * dimension return 409 DIMENSION_VALUE_DUPLICATE_CODE with a Swedish message.
 * `code` is immutable after creation (v1: no rename, retag instead).
 *
 * The rules live in createDimensionValue (lib/dimensions/registry-service.ts),
 * shared with the v1 route and the gnubok_create_dimension_value commit.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateDimensionValueSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createDimensionValue } from '@/lib/dimensions/registry-service'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const POST = withRouteContext(
  'dimension.value.create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const result = await validateBody(request, CreateDimensionValueSchema, {
      log: opLog,
      operation: 'dimension.value.create',
    })
    if (!result.success) return result.response

    const outcome = await createDimensionValue({ supabase, companyId, userId: user.id, log: opLog }, id, result.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
