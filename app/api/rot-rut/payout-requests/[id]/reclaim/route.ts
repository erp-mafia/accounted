import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutReclaimSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { reclaimRotRutRefusal } from '@/lib/invoices/rot-rut-reclaim'

/**
 * POST /api/rot-rut/payout-requests/[id]/reclaim
 *
 * Books the share of a begäran that Skatteverket refused back onto the
 * customer(s) and reopens their invoices for it:
 *
 *   Debit  1510 Kundfordringar               [refused share, per invoice]
 *   Credit 1513 Skattereduktion rot/rut      [refused share, per invoice]
 *
 * The amounts come from the recorded beslut (PATCH or beslutsfil import);
 * the body carries only the booking date. See lib/invoices/rot-rut-reclaim.ts
 * for every refusal.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'rot_rut.requests.reclaim',
  async (request, ctx, { params }) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const validation = await validateBody(request, RotRutReclaimSchema)
    if (!validation.success) return validation.response

    const outcome = await reclaimRotRutRefusal(supabase, user.id, companyId!, {
      requestId: id,
      bookingDate: validation.data.booking_date,
    })

    if (!outcome.ok) {
      if (outcome.kind === 'code') {
        return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
      }
      if (outcome.stage === 'book') {
        log.error('failed to book rot/rut reclaim entry', outcome.error as Error)
      } else {
        log.error('rot/rut reclaim failed', outcome.error as Error, { stage: outcome.stage })
      }
      return errorResponse(outcome.error, log, { requestId })
    }

    log.info('rot/rut refused share reclaimed', {
      userId: user.id,
      payoutRequestId: id,
      journalEntryId: outcome.journalEntryId,
      reclaimedTotal: outcome.reclaimedTotal,
    })

    return NextResponse.json({
      data: {
        journal_entry_id: outcome.journalEntryId,
        reclaimed_total: outcome.reclaimedTotal,
        invoices: outcome.invoices,
      },
    })
  },
  { requireWrite: true },
)
