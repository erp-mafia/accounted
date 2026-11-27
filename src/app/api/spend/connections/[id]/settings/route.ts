import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { SpendSettingsBodySchema } from '@/lib/spend/schemas'
import { updateSpendSettings } from '@/lib/spend/service'

/**
 * Change the wallet and utlägg accounts a connection's expenses book to.
 * Unbooked expenses are re-evaluated; booked ones never change. Rules in
 * lib/spend/service.ts, shared with the operation spend.update-settings.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'spend.settings.update',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const body = await validateBody(request, SpendSettingsBodySchema, { log, operation: 'spend.settings.update' })
    if (!body.success) return body.response
    const outcome = await updateSpendSettings(
      { supabase, companyId: companyId!, userId: user.id, log },
      { connection_id: id, settings: body.data.settings },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true, uuidParams: { id: 'SPEND_CONNECTION_NOT_FOUND' } },
)
