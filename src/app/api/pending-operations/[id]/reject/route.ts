import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PERSON_REJECTION_CATEGORIES } from '@/lib/pending-operations/rejection-categories'
import { rejectPendingOperations } from '@/lib/pending-operations/reject'

const RejectBodySchema = z.object({
  // A person's verdict, or 'superseded' when the assistant withdraws a
  // proposal because the person asked for a new answer (AgentChat). The other
  // system categories are written by the system itself, never by a client.
  rejection_category: z.enum([...PERSON_REJECTION_CATEGORIES, 'superseded']),
  rejection_reason: z.string().max(2000).optional(),
})

/**
 * POST /api/pending-operations/:id/reject
 *
 * Reject a pending operation. The JSON body names why: `rejection_category`
 * (required, fixed enum) and `rejection_reason` (optional free text), both
 * stored on the row so a person's "no" is never an unexplained one. The write
 * is lib/pending-operations/reject.ts, shared with bulk reject and MCP: it
 * records who rejected and appends the PendingOperationRejected audit row.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.reject',
  async (request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const validated = await validateBody(request, RejectBodySchema)
    if (!validated.success) return validated.response
    const rejectionCategory = validated.data.rejection_category
    const rejectionReason = validated.data.rejection_reason?.trim() || undefined

    const result = await rejectPendingOperations(supabase, {
      companyId,
      ids: [id],
      category: rejectionCategory,
      reason: rejectionReason,
      actor: { userId: user.id, type: 'user' },
      channel: 'app',
    })
    // 22P02: a malformed id in the path names no operation.
    if (!result.ok && result.stage === 'fetch' && result.error.code === '22P02') {
      return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
    }
    if (!result.ok) {
      log.error(`pending operation reject failed at ${result.stage}`, new Error(result.error.message))
      return NextResponse.json(
        { error: 'Åtgärden kunde inte avvisas. Försök igen.' },
        { status: 500 }
      )
    }

    const outcome = result.outcomes[0]
    if (outcome.outcome === 'not_found') {
      return NextResponse.json({ error: 'Pending operation not found' }, { status: 404 })
    }

    if (outcome.outcome === 'not_pending') {
      // There is no auto-commit path (removed in 20260505190027), so a non-pending
      // status here means the op was resolved explicitly: almost always the user
      // pressed Godkänn in the /pending (Att göra) UI in parallel, or another
      // client already rejected it. Spell that out so an agent doesn't read the
      // generic 409 as "the system committed it behind my back".
      const opStatus = outcome.status
      const explained =
        opStatus === 'rejected'
          ? 'Operation already rejected.'
          : opStatus === 'expired'
            ? 'Operation already expired and can no longer be rejected.'
            : opStatus === 'failed_partial'
              ? 'Operation already resolved as failed_partial: it failed after posting an ' +
                'irreversible voucher. It can no longer be rejected; see result_data.posted_ids ' +
                'for what was posted and correct it with a storno if needed.'
              : `Operation already ${opStatus}: it was approved explicitly (most likely via the ` +
                'Att göra / pending UI in parallel), not auto-committed. It can no longer be rejected; ' +
                'reverse or correct the resulting verifikat instead.'
      return NextResponse.json(
        { error: explained, status: opStatus },
        { status: 409 }
      )
    }

    if (outcome.outcome === 'lost_race') {
      // Read as pending, but commit claimed the row (pending -> committing)
      // before the guarded write: never stamp `rejected` over it.
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
