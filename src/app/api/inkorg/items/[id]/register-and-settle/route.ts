import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RegisterAndSettleInboxItemSchema } from '@/lib/api/schemas'
import { registerAndSettleInboxItem } from '@/lib/operations/inbox-register-and-settle'

/**
 * POST /api/inkorg/items/:id/register-and-settle
 *
 * The Inkorg's "Registrera och koppla till betalningen", from the form: a
 * supplier invoice that looks already paid by the bank row match on arrival
 * proposed is registered and settled against that row in one request. The
 * rules are in lib/operations/inbox-register-and-settle.ts, shared with the
 * one click (POST /api/inkorg/items/:id/book): the registration through the
 * convert door's service, the payment through bookSupplierBankMatch.
 *
 * Refused before anything is written: an item already converted, a proposal
 * that no longer stands (the row booked or claimed since) or names another
 * row, and a row that is not money out.
 *
 * Partial failure: when the registration went through and the settlement
 * did not, the invoice stays registered and unpaid, and the answer says so:
 * 200 with settled false and the settlement's error envelope, so the person
 * can link the payment from the invoice later.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inkorg.register_and_settle',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, RegisterAndSettleInboxItemSchema, {
      log,
      operation: 'inkorg.register_and_settle',
    })
    if (!validation.success) return validation.response

    const outcome = await registerAndSettleInboxItem({ supabase, companyId, userId: user.id, log, requestId }, id, validation.data)
    if (!outcome.ok) return outcome.response
    return NextResponse.json({
      data: outcome.data,
      ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
    })
  },
  { requireWrite: true },
)
