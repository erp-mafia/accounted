import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const RejectBodySchema = z.object({
  rejection_category: z
    .enum(['wrong_category', 'wrong_amount', 'duplicate', 'wrong_period', 'other'])
    .optional(),
  rejection_reason: z.string().max(2000).optional(),
})

/**
 * POST /api/pending-operations/:id/reject
 *
 * Reject a pending operation. Optionally accepts a JSON body with
 * `rejection_category` (fixed enum) and `rejection_reason` (free text). Both
 * are stored on the row so agents can fetch them via gnubok_get_recent_rejections
 * and learn from "no". The body is optional: bodyless POSTs from older
 * clients still mark the op rejected with NULL category/reason.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.reject',
  async (request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Body is optional: accept empty/missing body without rejecting the request.
    // Old clients posted no body; the UI dialog will now post a body, but we
    // keep accepting both shapes to avoid coupling the API to the UI version.
    let rejectionCategory: string | undefined
    let rejectionReason: string | undefined
    const contentLength = request.headers.get('content-length')
    if (contentLength && contentLength !== '0') {
      try {
        const raw = await request.json()
        const parsed = RejectBodySchema.safeParse(raw)
        if (!parsed.success) {
          return NextResponse.json(
            { error: parsed.error.issues.map((i) => i.message).join('; ') },
            { status: 400 },
          )
        }
        rejectionCategory = parsed.data.rejection_category
        rejectionReason = parsed.data.rejection_reason?.trim() || undefined
      } catch {
        // Body present but unparseable: fail closed.
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
      }
    }

    const { data: op, error: fetchError } = await supabase
      .from('pending_operations')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !op) {
      return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
    }

    if (op.status !== 'pending') {
      // There is no auto-commit path (removed in 20260505190027), so a non-pending
      // status here means the op was resolved explicitly: almost always the user
      // pressed Godkänn in the /pending (Att göra) UI in parallel, or another
      // client already rejected it. Spell that out so an agent doesn't read the
      // generic 409 as "the system committed it behind my back".
      const explained =
        op.status === 'rejected'
          ? 'Operation already rejected.'
          : op.status === 'expired'
            ? 'Operation already expired and can no longer be rejected.'
            : op.status === 'failed_partial'
              ? 'Operation already resolved as failed_partial: it failed after posting an ' +
                'irreversible voucher. It can no longer be rejected; see result_data.posted_ids ' +
                'for what was posted and correct it with a storno if needed.'
              : `Operation already ${op.status}: it was approved explicitly (most likely via the ` +
                'Att göra / pending UI in parallel), not auto-committed. It can no longer be rejected; ' +
                'reverse or correct the resulting verifikat instead.'
      return NextResponse.json(
        { error: explained, status: op.status },
        { status: 409 }
      )
    }

    // The status check above is a read, and commit claims rows atomically
    // (pending -> committing). Without a status guard on the write, a reject
    // that loses that race stamps `rejected` over an operation that has since
    // posted a verifikat: a booked entry whose row says rejected, which the
    // committing-state recovery sweep will never find. Guard the UPDATE the
    // same way bulk-reject does and report a lost race as 409.
    const { data: updated, error: updateError } = await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        ...(rejectionCategory ? { rejection_category: rejectionCategory } : {}),
        ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .select('id')

    if (updateError) {
      return NextResponse.json({ error: getUserErrorMessage(updateError) }, { status: 500 })
    }

    if (!updated || updated.length === 0) {
      return NextResponse.json(
        {
          error:
            'Åtgärden hann behandlas av någon annan och kunde inte avvisas. ' +
            'Ladda om sidan och kontrollera resultatet.',
        },
        { status: 409 },
      )
    }

    return NextResponse.json({ data: { id, status: 'rejected' } })
  },
  { requireWrite: true },
)
