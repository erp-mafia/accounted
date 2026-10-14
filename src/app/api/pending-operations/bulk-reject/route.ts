import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PendingOperationsBulkRejectSchema } from '@/lib/api/schemas'
import { rejectPendingOperations } from '@/lib/pending-operations/reject'

interface BulkRejectItemResult {
  id: string
  status: 'rejected' | 'failed' | 'skipped'
  error?: string
}

// Swedish display labels for already-handled operations; the raw enum values
// are English and must not reach the user-visible per-item error strings.
const STATUS_LABELS_SV: Record<string, string> = {
  committing: 'godkänns just nu',
  committed: 'godkänd',
  rejected: 'avvisad',
  expired: 'utgången',
  failed_partial: 'delvis genomförd',
}

/**
 * POST /api/pending-operations/bulk-reject
 *
 * Reject up to 100 pending operations in one call. Requires
 * `rejection_category` and optionally takes `rejection_reason`, applied to
 * every rejected row, same as the single reject route (one shared write,
 * lib/pending-operations/reject.ts: who rejected, plus an audit row per
 * rejected operation). Unlike bulk-commit there is no high-risk skip here:
 * rejecting posts nothing to the ledger, so it is safe at any risk tier.
 */
export const POST = withRouteContext(
  'pending_operation.bulk_reject',
  async (request, { supabase, companyId, user, log }) => {
    const validated = await validateBody(request, PendingOperationsBulkRejectSchema)
    if (!validated.success) return validated.response
    const { ids, rejection_category } = validated.data
    const rejectionReason = validated.data.rejection_reason?.trim() || undefined

    const result = await rejectPendingOperations(supabase, {
      companyId,
      ids,
      category: rejection_category,
      reason: rejectionReason,
      actor: { userId: user.id, type: 'user' },
      channel: 'app',
    })

    if (!result.ok) {
      log.error(`bulk reject ${result.stage} failed`, new Error(result.error.message))
      return NextResponse.json(
        {
          error:
            result.stage === 'fetch'
              ? 'Åtgärderna kunde inte hämtas. Försök igen.'
              : 'Operationerna kunde inte avvisas. Försök igen.',
        },
        { status: 500 }
      )
    }

    const results: BulkRejectItemResult[] = result.outcomes.map((outcome) => {
      switch (outcome.outcome) {
        case 'rejected':
          return { id: outcome.id, status: 'rejected' as const }
        case 'not_found':
          return { id: outcome.id, status: 'failed' as const, error: 'Åtgärden kunde inte hittas.' }
        case 'not_pending':
          return {
            id: outcome.id,
            status: 'skipped' as const,
            error: `Redan hanterad (${STATUS_LABELS_SV[outcome.status] ?? outcome.status})`,
          }
        case 'lost_race':
          // Fetched as pending but not updated: resolved by another session
          // between the read and the guarded write.
          return { id: outcome.id, status: 'skipped' as const, error: 'Hanterades i en annan session.' }
      }
    })

    const summary = {
      total: results.length,
      rejected: results.filter((r) => r.status === 'rejected').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
    }

    return NextResponse.json({ data: { results, summary } })
  },
  { requireWrite: true },
)
