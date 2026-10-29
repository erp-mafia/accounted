import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { listSignatureRequests } from '@/lib/bokslut/arsredovisning/signature-service'
import { addArsredovisningSignatory } from '@/lib/bokslut/arsredovisning/workflow-service'
import { loadRoles } from '@/lib/bolaget/roles'
import { rosterFromRoles } from '@/lib/bolaget/roster'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'

async function candidates(ctx: Parameters<typeof operationContext>[0], periodId: string) {
  const [roles, roster] = await Promise.all([loadRoles(operationContext(ctx), null), listSignatureRequests(ctx.supabase, ctx.companyId, periodId)])
  const pending = (roster as Array<{ signer_name: string; status: string; annual_report_version_id: string | null }>).filter(
    (r) => r.status === 'pending' && r.annual_report_version_id === null,
  )
  return rosterFromRoles(roles, pending)
}

/**
 * GET /api/bookkeeping/fiscal-periods/{id}/arsredovisning/signatures/from-roles:
 * the board members and VD in office (Styrelse och firmateckning) who are
 * not yet on the signer roster. 404 outside the Bolaget rollout.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>('period.arsredovisning_signatures_from_roles', async (_request, ctx, { params }) => {
  const { id } = await params
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  return NextResponse.json({ data: { candidates: await candidates(ctx, id) } })
})

/** POST: add them to the roster ("Hämta från styrelsen"), each through the roster's own rules. */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.arsredovisning_signatures_from_roles_add',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const added = []
    for (const candidate of await candidates(ctx, id)) {
      const outcome = await addArsredovisningSignatory(operationContext(ctx), id, candidate, { dryRun: false })
      if (!outcome.ok) {
        if (outcome.code === 'ARSREDOVISNING_SIGNER_ALREADY_EXISTS') continue
        return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
      }
      if (!outcome.dryRun) added.push(outcome.data)
    }
    return NextResponse.json({ data: { added } })
  },
  { requireWrite: true },
)
