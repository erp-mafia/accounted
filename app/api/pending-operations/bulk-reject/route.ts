import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PendingOperationsBulkRejectSchema } from '@/lib/api/schemas'

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
 * Reject up to 100 pending operations in one call. Optionally accepts
 * `rejection_category` and `rejection_reason`, applied to every rejected row
 * so agents can learn from "no" via gnubok_get_recent_rejections, same as the
 * single reject route. Unlike bulk-commit there is no high-risk skip here:
 * rejecting posts nothing to the ledger, so it is safe at any risk tier.
 */
export const POST = withRouteContext(
  'pending_operation.bulk_reject',
  async (request, { supabase, companyId, log }) => {
    const validated = await validateBody(request, PendingOperationsBulkRejectSchema)
    if (!validated.success) return validated.response
    const { ids, rejection_category } = validated.data
    const rejectionReason = validated.data.rejection_reason?.trim() || undefined

    const { data: ops, error: fetchError } = await supabase
      .from('pending_operations')
      .select('id, status')
      .in('id', ids)
      .eq('company_id', companyId)

    if (fetchError) {
      log.error('failed to fetch pending operations for bulk reject', fetchError)
      return NextResponse.json(
        { error: 'Åtgärderna kunde inte hämtas. Försök igen.' },
        { status: 500 }
      )
    }

    const opsById = new Map(
      ((ops ?? []) as Array<{ id: string; status: string }>).map((op) => [op.id, op])
    )
    const pendingIds = ids.filter((id) => opsById.get(id)?.status === 'pending')

    // One guarded UPDATE for the whole batch: the status filter keeps a row
    // that was committed in a parallel session from being flipped to rejected
    // underneath that approver. Rows the guard filtered out are reported as
    // skipped below instead of failing the request.
    let rejectedIds = new Set<string>()
    if (pendingIds.length > 0) {
      const { data: updated, error: updateError } = await supabase
        .from('pending_operations')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          ...(rejection_category ? { rejection_category } : {}),
          ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
        })
        .in('id', pendingIds)
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .select('id')

      if (updateError) {
        log.error('bulk reject update failed', updateError)
        return NextResponse.json(
          { error: 'Operationerna kunde inte avvisas. Försök igen.' },
          { status: 500 }
        )
      }
      rejectedIds = new Set(
        ((updated ?? []) as Array<{ id: string }>).map((row) => row.id)
      )
    }

    const results: BulkRejectItemResult[] = ids.map((id) => {
      const op = opsById.get(id)
      if (!op) {
        return { id, status: 'failed' as const, error: 'Åtgärden kunde inte hittas.' }
      }
      if (rejectedIds.has(id)) {
        return { id, status: 'rejected' as const }
      }
      if (op.status !== 'pending') {
        return {
          id,
          status: 'skipped' as const,
          error: `Redan hanterad (${STATUS_LABELS_SV[op.status] ?? op.status})`,
        }
      }
      // Fetched as pending but not updated: resolved by another session
      // between our read and the guarded write.
      return { id, status: 'skipped' as const, error: 'Hanterades i en annan session.' }
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
