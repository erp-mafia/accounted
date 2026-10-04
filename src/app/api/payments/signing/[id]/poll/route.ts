import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { pollPaymentSigning } from '@/lib/payments/orders/signing'

ensureInitialized()

const PollSchema = z.object({ personal_number: z.string().max(20).nullish() })

/**
 * POST /api/payments/signing/:id/poll: where the BankID signing stands. While
 * pending it answers fresh QR data (the animated QR changes every second);
 * once finalised it has read and applied each payment's status.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_signing.poll',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, PollSchema)
    if (!validation.success) return validation.response
    const outcome = await pollPaymentSigning(
      { supabase, companyId, userId: user.id, log },
      { batchId: id, signer: signerFromRequest(request, validation.data.personal_number) },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
