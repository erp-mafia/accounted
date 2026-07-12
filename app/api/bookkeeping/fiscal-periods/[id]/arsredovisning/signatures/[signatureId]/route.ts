import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'

// PATCH transitions: pending → signed (manual entry for the paper / outside-
// BankID flow) or pending → declined. Real BankID wiring lands in a future
// phase and uses the same UPDATE with the BankID callback as trigger.
//
// Hardening on every UPDATE:
//   - .eq('id', signatureId) + .eq('company_id', companyId)
//   - .eq('fiscal_period_id', id from URL): enforces the REST contract so
//     /periods/A/signatures/SIG_FROM_B can't bypass the path scope
//   - .eq('status', 'pending'): state-machine guard so a signed or declined
//     row can't be flipped back
const PatchSchema = z.object({
  status: z.enum(['signed', 'declined']),
})

export const PATCH = withRouteContext(
  'period.arsredovisning_signature_patch',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; signatureId: string }> },
  ) => {
    const { id: fiscalPeriodId, signatureId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response

    const update =
      validation.data.status === 'signed'
        ? { status: 'signed' as const, signed_at: new Date().toISOString() }
        : { status: 'declined' as const }

    try {
      const { data, error } = await supabase
        .from('arsredovisning_signature_requests')
        .update(update)
        .eq('id', signatureId)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to update signature: ${error.message}`)
      }
      if (!data) {
        // No row matched: either it doesn't exist, belongs to another
        // company / period, or is already signed/declined. Return 409 so
        // the client knows the transition is invalid rather than "missing".
        return NextResponse.json(
          { error: { code: 'SIGNATURE_INVALID_TRANSITION' } },
          { status: 409 },
        )
      }
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
