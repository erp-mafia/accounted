import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutRequestPatchSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { RotRutPayoutRequestStatus } from '@/types'

/**
 * Forward-only lifecycle. Reactivation of cancelled/rejected begäran is
 * deliberately impossible from the API (and double-guarded by the DB
 * trigger enforce_rot_rut_request_reactivation): retry after avslag means
 * generating a NEW file, mirroring how Skatteverkets e-tjänst works.
 */
const ALLOWED_TRANSITIONS: Record<RotRutPayoutRequestStatus, RotRutPayoutRequestStatus[]> = {
  generated: ['submitted', 'cancelled'],
  submitted: ['paid', 'partially_paid', 'rejected', 'cancelled'],
  paid: [],
  partially_paid: [],
  rejected: [],
  cancelled: [],
}

/**
 * PATCH /api/rot-rut/payout-requests/[id]
 *
 * Advance the begäran lifecycle: mark the file as uploaded (submitted), or
 * record Skatteverkets beslut (paid / partially_paid / rejected +
 * decided_total). Booking the actual payout is POST [id]/settle.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'rot_rut.requests.patch',
  async (request, ctx, { params }) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const validation = await validateBody(request, RotRutRequestPatchSchema)
    if (!validation.success) return validation.response
    const input = validation.data

    const { data: payoutRequest, error: fetchError } = await supabase
      .from('rot_rut_payout_requests')
      .select('*')
      .eq('company_id', companyId!)
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      log.error('failed to fetch rot/rut payout request', fetchError)
      return errorResponse(fetchError, log, { requestId })
    }
    if (!payoutRequest) {
      return errorResponseFromCode('ROT_RUT_REQUEST_NOT_FOUND', log, { requestId })
    }

    const from = payoutRequest.status as RotRutPayoutRequestStatus
    if (!ALLOWED_TRANSITIONS[from]?.includes(input.status)) {
      return errorResponseFromCode('ROT_RUT_INVALID_STATUS_TRANSITION', log, {
        requestId,
        details: { from, to: input.status },
      })
    }
    // Partial approval without the approved amount is meaningless.
    if (input.status === 'partially_paid' && input.decided_total === undefined) {
      return errorResponseFromCode('ROT_RUT_INVALID_STATUS_TRANSITION', log, {
        requestId,
        details: { from, to: input.status, reason: 'decided_total krävs för delvis beviljad' },
      })
    }

    const now = new Date().toISOString()
    const update: Record<string, unknown> = { status: input.status }
    if (input.status === 'submitted') {
      update.submitted_at = now
    }
    if (input.status === 'paid' || input.status === 'partially_paid' || input.status === 'rejected') {
      update.decided_at = now
      update.decided_total =
        input.decided_total ??
        (input.status === 'paid' ? payoutRequest.requested_total : 0)
    }

    const { data: updated, error: updateError } = await supabase
      .from('rot_rut_payout_requests')
      .update(update)
      .eq('company_id', companyId!)
      .eq('id', id)
      .select(
        'id, name, deduction_type, status, requested_total, decided_total, submitted_at, decided_at, settlement_journal_entry_id',
      )
      .single()

    if (updateError) {
      log.error('failed to update rot/rut payout request', updateError)
      return errorResponse(updateError, log, { requestId })
    }

    // Status transitions record Skatteverkets beslut: the audit trail must
    // show who recorded them.
    log.info('rot/rut payout request status changed', {
      userId: user.id,
      payoutRequestId: id,
      from,
      to: input.status,
      decidedTotal: update.decided_total ?? null,
    })

    // Full approval: mirror the per-invoice godkänt belopp onto the items.
    // Partial approval leaves item amounts null: the split is only known
    // from Skatteverkets beslut, never guessed.
    if (input.status === 'paid' && input.decided_total === undefined) {
      const { data: items, error: itemsFetchError } = await supabase
        .from('rot_rut_payout_request_items')
        .select('id, requested_amount')
        .eq('request_id', id)
      if (itemsFetchError) {
        log.warn('failed to fetch items for decided_amount mirror', {
          requestId: id,
          message: itemsFetchError.message,
        })
      } else {
        for (const item of items ?? []) {
          const { error: mirrorError } = await supabase
            .from('rot_rut_payout_request_items')
            .update({ decided_amount: item.requested_amount })
            .eq('id', item.id)
          if (mirrorError) {
            log.warn('failed to mirror decided_amount onto item', {
              itemId: item.id,
              message: mirrorError.message,
            })
          }
        }
      }
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
