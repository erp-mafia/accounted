import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { switchCampaign, switchMailsEnabled, switchStatesForCompanies } from '@/lib/bank-feed/switch-campaign'
import { sendByraNudge, type ByraNudgeOutcome } from '@/lib/bank-feed/switch-notifications'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

const log = createLogger('api/clients/bank-switch/remind')

const RemindSchema = z
  .object({
    /** One client company to nudge. */
    company_id: z.string().uuid().optional(),
    /** Every client company that has not switched yet. */
    all: z.boolean().optional(),
  })
  .refine((body) => (body.company_id !== undefined) !== (body.all === true), {
    message: 'Pass company_id or all: true, not both',
  })

type ClientCompany = { id: string }
type Membership = { company_id: string; role: string }

/**
 * POST /api/clients/bank-switch/remind: a byrå asks its client to switch the
 * bank connection. `{ company_id }` mails one client's owners and admins the
 * campaign announcement (lib/bank-feed/switch-notifications.ts, at most once
 * per 7 days per client); `{ all: true }` does it for every client that has
 * not switched yet and answers how many went.
 *
 * Uses requireAuth() directly (the sanctioned withRouteContext opt-out, MFA
 * still enforced): the byrå cockpit has no active-company context. The
 * caller must belong to a byrå team, the company must be one of that team's
 * clients, and the caller must hold a write role in it (any company_members
 * role but viewer), which the team sync grants every byrå member. Refused
 * with a clear code while the campaign or its mails are off, so a byrå never
 * presses a button that silently does nothing.
 */
export async function POST(request: Request) {
  const requestId = `req_${crypto.randomUUID()}`
  try {
    return await handle(request, requestId)
  } catch (error) {
    return errorResponse(error, log, { requestId })
  }
}

async function handle(request: Request, requestId: string) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const membership = await getByraMembership(supabase, user.id)
  if (!membership) {
    return errorResponseFromCode('FORBIDDEN', log, {
      requestId,
      messageSv: 'Endast byråteam kan be sina kunder koppla banken.',
      messageEn: 'Only byrå teams can ask their clients to connect the bank.',
    })
  }

  const validation = await validateBody(request, RemindSchema)
  if (!validation.success) return validation.response

  const campaign = switchCampaign()
  if (!campaign.on) return errorResponseFromCode('BANK_SWITCH_CAMPAIGN_OFF', log, { requestId })
  if (!switchMailsEnabled()) return errorResponseFromCode('BANK_SWITCH_MAILS_OFF', log, { requestId })

  const service = createServiceClient()
  const { data: companies, error: companiesError } = await service
    .from('companies')
    .select('id')
    .eq('team_id', membership.teamId)
    .is('archived_at', null)
  if (companiesError) throw companiesError
  const clientIds = ((companies ?? []) as ClientCompany[]).map((c) => c.id)

  // The write role: the caller's own membership in each client, viewer excluded.
  const { data: memberships, error: membershipsError } = await service
    .from('company_members')
    .select('company_id, role')
    .eq('user_id', user.id)
    .in('company_id', clientIds.length > 0 ? clientIds : ['00000000-0000-0000-0000-000000000000'])
  if (membershipsError) throw membershipsError
  const writable = new Set(((memberships ?? []) as Membership[]).filter((m) => m.role !== 'viewer').map((m) => m.company_id))

  const now = new Date()
  const body = validation.data

  if (body.company_id) {
    if (!clientIds.includes(body.company_id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    if (!writable.has(body.company_id)) return errorResponseFromCode('FORBIDDEN', log, { requestId })
    const states = await switchStatesForCompanies(service, [body.company_id], { now })
    const result = await sendByraNudge(service, { companyId: body.company_id, state: states.get(body.company_id) ?? null, now, log })
    const failure = failureCode(result.outcome)
    if (failure) {
      return errorResponseFromCode(failure, log, { requestId, details: result.last_sent_at ? { last_sent_at: result.last_sent_at } : undefined })
    }
    return NextResponse.json({ data: { outcome: result.outcome, recipients: result.recipients } })
  }

  const targets = clientIds.filter((id) => writable.has(id))
  const states = await switchStatesForCompanies(service, targets, { now })
  const summary = { sent: 0, recently_sent: 0, no_recipient: 0, not_pending: 0, failed: 0 }
  for (const companyId of targets) {
    const state = states.get(companyId) ?? null
    if (!state || state.state !== 'pending') {
      summary.not_pending++
      continue
    }
    const result = await sendByraNudge(service, { companyId, state, now, log })
    if (result.outcome === 'sent') summary.sent++
    else if (result.outcome === 'recently_sent') summary.recently_sent++
    else if (result.outcome === 'no_recipient') summary.no_recipient++
    else if (result.outcome === 'not_pending') summary.not_pending++
    else summary.failed++
  }
  return NextResponse.json({ data: summary })
}

/** The error code a single nudge answers with, or null when it went. */
function failureCode(outcome: ByraNudgeOutcome): string | null {
  switch (outcome) {
    case 'sent':
      return null
    case 'recently_sent':
      return 'BANK_SWITCH_RECENTLY_SENT'
    case 'not_pending':
      return 'BANK_SWITCH_NOT_PENDING'
    case 'no_recipient':
      return 'BANK_SWITCH_NO_RECIPIENT'
    case 'not_configured':
    case 'failed':
      return 'BANK_SWITCH_MAIL_FAILED'
  }
}
