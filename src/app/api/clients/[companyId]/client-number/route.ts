import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { ClientNumberBodySchema } from '@/lib/clients/client-number'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/clients/client-number')

type RouteContext = { params: Promise<{ companyId: string }> }

/**
 * PUT /api/clients/:companyId/client-number: the byrå sets, changes or clears
 * its own customer number for one client company (crm#1279), from the
 * Klienter list. Body `{ client_number: string | null }`; an empty string
 * clears it. Answers `{ data: { company_id, client_number } }`.
 *
 * Uses requireAuth() directly (the sanctioned withRouteContext opt-out, MFA
 * still enforced): the byrå cockpit has no active-company context. The
 * caller must be an owner or admin of a byrå team, the same roles that may
 * create client companies, and the company must be one of that team's
 * non-archived clients (404 otherwise, so other companies' existence does
 * not leak). The write runs on the caller's own session, so the
 * companies_update policy (company admin, which team sync makes every byrå
 * owner/admin) still applies underneath.
 */
export async function PUT(request: Request, context: RouteContext) {
  const requestId = `req_${crypto.randomUUID()}`
  try {
    return await handle(request, context, requestId)
  } catch (error) {
    return errorResponse(error, log, { requestId })
  }
}

async function handle(request: Request, context: RouteContext, requestId: string) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const membership = await getByraMembership(supabase, user.id)
  if (!membership || membership.role === 'member') {
    return errorResponseFromCode('FORBIDDEN', log, {
      requestId,
      messageSv: 'Endast byråns ägare och administratörer kan ändra kundnummer.',
      messageEn: "Only the byrå's owners and admins can change customer numbers.",
    })
  }

  const { companyId } = await context.params
  if (!z.string().uuid().safeParse(companyId).success) {
    return errorResponseFromCode('NOT_FOUND', log, { requestId })
  }

  const validation = await validateBody(request, ClientNumberBodySchema)
  if (!validation.success) return validation.response
  const clientNumber = validation.data.client_number

  const { data: client, error: clientError } = await supabase
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .eq('team_id', membership.teamId)
    .is('archived_at', null)
    .maybeSingle()
  if (clientError) throw clientError
  if (!client) return errorResponseFromCode('NOT_FOUND', log, { requestId })

  const { data: updated, error: updateError } = await supabase
    .from('companies')
    .update({ byra_client_number: clientNumber })
    .eq('id', companyId)
    .eq('team_id', membership.teamId)
    .select('id, byra_client_number')
    .maybeSingle()
  if (updateError) throw updateError
  // RLS matched no row: the caller is a team admin without the company admin
  // role in this client (a membership that predates the team sync).
  if (!updated) return errorResponseFromCode('FORBIDDEN', log, { requestId })

  const row = updated as { id: string; byra_client_number: string | null }
  return NextResponse.json({ data: { company_id: row.id, client_number: row.byra_client_number } })
}
