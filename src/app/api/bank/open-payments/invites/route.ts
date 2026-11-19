import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { openBankFeedDoor } from '@/lib/bank-feed/door'
import { issueSignatoryLink } from '@/lib/bank-feed/invites'
import { sessionFailureResponse } from '@/lib/operations/session'

const InviteSchema = z.object({
  bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).nullish(),
  /** The connection the new one takes over from (an Enable Banking row for a switch, an Open Payments row for a renewal). */
  replace_connection_id: z.uuid().nullish(),
  offer_payments: z.boolean().default(false),
  recipient_email: z.email().max(254).nullish(),
  /** The bank as the sender's screen names it, for the mail only. */
  bank_name: z.string().max(100).nullish(),
})

/**
 * POST /api/bank/open-payments/invites: send the company's firmatecknare a
 * signatory link (lib/bank-feed/invites.ts): a signed URL, valid 7 days, that
 * opens the Koppla banken flow for this company without a login. Owners and
 * admins only (requireAdmin, and the table's RLS policy says the same). With
 * recipient_email the link is mailed; the URL comes back either way so the
 * sender can pass it on by other means. Answers { url, expires_at, email_sent }.
 */
export const POST = withRouteContext(
  'bank_feed.invite',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const ctx = { supabase, companyId, userId: user.id, log }
    // A link into a closed door is a dead end for the firmatecknare: the same
    // door as every other entry point, answered before anything is stored.
    const door = await openBankFeedDoor(ctx)
    if (!door.ok) return sessionFailureResponse({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: door.reason } }, log, requestId)
    const validation = await validateBody(request, InviteSchema)
    if (!validation.success) return validation.response
    const outcome = await issueSignatoryLink(
      ctx,
      {
        bic: validation.data.bic ?? null,
        replaceConnectionId: validation.data.replace_connection_id ?? null,
        offerPayments: validation.data.offer_payments,
        recipientEmail: validation.data.recipient_email ?? null,
        bankName: validation.data.bank_name ?? null,
      },
      // withRouteContext already asked the admin predicate; the RLS insert policy asks again.
      { checkAdmin: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireAdmin: true },
)
