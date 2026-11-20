import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUuid } from '@/lib/invariants/uuid'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelPaymentSigningLink } from '@/lib/payments/orders/signing-links'

/**
 * DELETE /api/payments/signing-links/:id: Avbryt länken. The link stops
 * opening anything; the orders stay approved for the company to sign or send
 * again. The sender, owners and admins.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_signing_link.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return sessionFailureResponse({ ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_FOUND' }, log, requestId)
    const outcome = await cancelPaymentSigningLink({ supabase, companyId, userId: user.id, log }, { signingLinkId: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
