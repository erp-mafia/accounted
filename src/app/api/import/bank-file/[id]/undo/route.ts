import { NextResponse } from 'next/server'
import { undoBankImport } from '@/lib/import/bank-file/undo-operation'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'

// Bulk-deleting a large batch (a full-year CSV is thousands of rows) can take
// longer than the default function timeout. Match the bank-file execute route
// so the serverless function doesn't kill the request first.
export const maxDuration = 300

/**
 * DELETE /api/import/bank-file/[id]/undo
 *
 * Undo a completed bank file import: hard-deletes the batch's unbooked
 * transactions, INCLUDING ignored ones, and marks the bank_file_imports row
 * 'undone' so the same file can be re-imported cleanly (the execute route's
 * upsert reuses the row). Booked rows (verifikat-anchored) and unbooked rows
 * with payment_match_log history are never touched and are reported.
 * Owner/admin only. Rules in lib/import/bank-file/undo-operation.ts, shared
 * with POST /api/v1/companies/{companyId}/imports/bank/{id}/undo.
 */
export const DELETE = withRouteContext(
  'bank_file.undo',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ bankFileImportId: id })

    const outcome = await undoBankImport({ supabase, companyId: companyId!, userId: user.id, log: opLog }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })

    return NextResponse.json({
      success: true,
      deletedTransactions: outcome.data.deleted_transactions,
      skippedBooked: outcome.data.skipped_booked,
      skippedMatchHistory: outcome.data.skipped_match_history,
    })
  },
  { requireWrite: true },
)
