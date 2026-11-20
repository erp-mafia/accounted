import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { sessionFailureResponse } from '@/lib/operations/session'
import { signerFromRequest } from '@/lib/payments/orders/request-signer'
import { startSecondSignature } from '@/lib/payments/orders/signing'

// One status read per payment (up to 100) and BankID, as the restart.
export const maxDuration = 300

const SecondSignatureSchema = z.object({
  /** BankID in our screen (same_device, qr) or on the bank's own page (redirect); a bank that signs only there gets redirect whatever is asked. */
  method: z.enum(['same_device', 'qr', 'redirect']),
  /** The other signatory's personnummer; the person's own on file when absent. */
  personal_number: z.string().max(20).nullish(),
  /** Nordea Corporate Netbank: the signer's own logon id, when they use it. Sent with a Nordea signing only, never stored. */
  psu_authoriser_id: z.string().max(100).nullish(),
})

/**
 * POST /api/payments/signing/:id/second-signature: the other signatory's
 * BankID for a signing the bank holds for them (awaiting_second_signer) at a
 * bank that takes the second signature through the API. The poll route
 * follows it as any signing.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'payment_signing.second_signature',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, SecondSignatureSchema)
    if (!validation.success) return validation.response
    const outcome = await startSecondSignature(
      { supabase, companyId, userId: user.id, log },
      {
        batchId: id,
        method: validation.data.method,
        signer: signerFromRequest(request, validation.data.personal_number, validation.data.psu_authoriser_id),
        returnOrigin: await resolveRequestAppOrigin(request, { onLookupFailure: 'canonical' }),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
