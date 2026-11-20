import { NextResponse } from 'next/server'
import { withInviteToken } from '@/lib/bank-feed/invite-route'
import { disconnectBankFeedConnection, getBankFeedConnection } from '@/lib/bank-feed/service'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'

type P = { token: string; id: string }

/** GET /api/koppla/:token/connections/:id: the connection as the flow shows it after Svea's second consent. */
export const GET = withInviteToken<P>('bank_feed.connection', { stage: 'follow_up' }, async (_request, { op, log, requestId }, { id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const outcome = await getBankFeedConnection(op, id)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

/**
 * DELETE /api/koppla/:token/connections/:id: the firmatecknare closed over a
 * running BankID or an unsaved selection, and the half-made connection goes.
 * Only an attempt this link could have made is removable: a live connection
 * of the company is out of reach from a link.
 */
export const DELETE = withInviteToken<P>('bank_feed.disconnect', { stage: 'open' }, async (_request, { op, log, requestId }, { id }) => {
  if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  const { data } = await op.supabase.from('bank_connections').select('id, status').eq('id', id).eq('company_id', op.companyId).maybeSingle()
  const row = data as { id: string; status: string } | null
  if (!row || (row.status !== 'pending' && row.status !== 'pending_selection')) {
    return sessionFailureResponse({ ok: false, code: 'NOT_FOUND' }, log, requestId)
  }
  const outcome = await disconnectBankFeedConnection(op, id)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
