import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/pending-operations/expire/cron, daily 02:30 UTC.
 *
 * Auto-rejects staged operations that have sat at status='pending' for more
 * than 30 days. AI agents stage operations for human review; when the chat
 * session is abandoned the proposal would otherwise linger in the worklist
 * forever, asking the user to Godkänn/Avvisa something whose context they no
 * longer remember. A 30-day-old proposal has lost its context regardless of
 * risk level, so the sweep applies uniformly.
 *
 * Rows are flipped to 'rejected' (never deleted: the table is the audit
 * trail) with the same result_data shape the commit dispatcher uses for its
 * own auto-rejects (lib/pending-operations/commit.ts). The strict
 * reason: 'expired' marker is what the /pending UI keys its
 * "Utgick automatiskt" badge on. rejection_category/rejection_reason stay
 * NULL: those carry user feedback semantics, and an expiry is not feedback.
 *
 * If you change EXPIRY_DAYS, update the user-facing copy that states the
 * window: pending.auto_expiry_note + pending.auto_expired_detail in
 * messages/{sv,en}.json and the static note in components/agent/ApprovalCard.tsx.
 */
const EXPIRY_DAYS = 30

export const GET = withCronContext('cron.pending_operations_expire', async (_request, ctx) => {
  const supabase = createServiceClient()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - EXPIRY_DAYS)

  // CAS on status='pending': rows a concurrent commit has claimed (status
  // 'committing') or already resolved are skipped; the status-immutability
  // trigger never fires because OLD.status is always 'pending' here.
  // result_data is NULL on pending rows, so plain assignment is the merge.
  const { data, error } = await supabase
    .from('pending_operations')
    .update({
      status: 'rejected',
      resolved_at: new Date().toISOString(),
      result_data: { auto_rejected: true, reason: 'expired' },
    })
    .eq('status', 'pending')
    .lt('created_at', cutoff.toISOString())
    .select('id, company_id')

  if (error) {
    ctx.log.error('pending operations expiry failed', error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }

  const expired = data?.length ?? 0
  ctx.log.info('pending operations expiry summary', {
    expired,
    cutoff: cutoff.toISOString(),
  })

  return NextResponse.json({ success: true, expired, cutoff: cutoff.toISOString() })
})
