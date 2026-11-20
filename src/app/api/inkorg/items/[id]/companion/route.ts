import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { FollowInboxCompanionSchema } from '@/lib/api/schemas'
import { followInvoiceWithReceipt } from '@/lib/operations/inbox-companion'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/inkorg/items/:id/companion
 *
 * The receipt follows its invoice. An invoice and the receipt it came with
 * as one purchase (lib/inkorg/pairs.ts) are one row in the Inkorg; when the
 * person's answer has booked the invoice, the page asks here for the receipt
 * (body: receipt_item_id) to land on that same booking, so the purchase is
 * booked once. The rules are in lib/operations/inbox-companion.ts: the pair
 * is checked again, nothing is booked and no verifikat changes; the receipt
 * is matched to the invoice's booked bank row, or its document is linked to
 * the invoice's own verifikat.
 *
 * Answers 200 { data: { status } }: completed (the receipt is an underlag of
 * the verifikat), waiting (nothing written, the receipt stays in the inbox
 * for a person, with why) or already_done. 404 when either item is not the
 * company's, 409 INBOX_COMPANION_NOT_PAIRED when the two are not one
 * purchase.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inkorg.companion',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, FollowInboxCompanionSchema, { log, operation: 'inkorg.companion' })
    if (!validation.success) return validation.response

    const outcome = await followInvoiceWithReceipt({ supabase, companyId, userId: user.id, log }, id, validation.data.receipt_item_id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
