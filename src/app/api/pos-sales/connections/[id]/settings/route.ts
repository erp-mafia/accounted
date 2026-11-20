import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { PosSettingsBodySchema } from '@/lib/pos-sales/schemas'
import { updatePosSalesSettings } from '@/lib/pos-sales/service'

/**
 * Change the accounts a venue's days are booked to. Unbooked days are
 * re-evaluated against the new mapping; booked days never change. Rules in
 * lib/pos-sales/service.ts, shared with the operation pos-sales.update-settings.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pos_sales.settings.update',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const body = await validateBody(request, PosSettingsBodySchema, { log, operation: 'pos_sales.settings.update' })
    if (!body.success) return body.response
    const outcome = await updatePosSalesSettings(
      { supabase, companyId: companyId!, userId: user.id, log },
      { connection_id: id, settings: body.data.settings },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
