import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { issuePaymentSigningLink, listOpenPaymentSigningLinks, SIGNING_LINK_NOTE_MAX } from '@/lib/payments/orders/signing-links'

const IssueSchema = z.object({
  order_ids: z.array(z.uuid()).min(1).max(100),
  recipient_email: z.email().max(254).nullish(),
  note: z.string().max(SIGNING_LINK_NOTE_MAX).nullish(),
})

/**
 * GET /api/payments/signing-links: the company's open signing links (not
 * consumed, cancelled or expired), so Betalningar can say which approved
 * orders wait for someone else's signature. Never the token.
 */
export const GET = withRouteContext('payment_signing_link.list', async (_request, { supabase, companyId }) => {
  return NextResponse.json({ data: await listOpenPaymentSigningLinks({ supabase, companyId }) })
})

/**
 * POST /api/payments/signing-links: Be någon annan signera. A link, valid 72
 * hours, where someone without an Accounted login (the company's
 * firmatecknare) signs these approved payments with BankID
 * (lib/payments/orders/signing-links.ts). Owners and admins, or the person
 * who prepared every order. With recipient_email the link is mailed; the URL
 * comes back either way so the sender can copy it. Answers
 * { signing_link_id, url, expires_at, email_sent, order_count, total_amount, currency }.
 */
export const POST = withRouteContext(
  'payment_signing_link.issue',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, IssueSchema)
    if (!validation.success) return validation.response
    const outcome = await issuePaymentSigningLink(
      { supabase, companyId, userId: user.id, log },
      { orderIds: validation.data.order_ids, recipientEmail: validation.data.recipient_email ?? null, note: validation.data.note ?? null },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
