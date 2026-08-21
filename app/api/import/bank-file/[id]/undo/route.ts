import { NextResponse } from 'next/server'
import { undoBankFileImport } from '@/lib/import/bank-file/undo'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

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
 * upsert reuses the row). Rows it never touches, reported in the response:
 *   - booked rows (verifikat-anchored, direct or via payment/voucher links):
 *     räkenskapsinformation; unlink or storno, never delete.
 *   - unbooked rows with payment_match_log history: the log is append-only
 *     (BFL 7 kap) and cascades on delete, so the parent row must stay; it can
 *     be ignored instead. Same rule as DELETE /api/transactions/[id].
 * Owner/admin only (enforced by the undo_bank_file_import RPC's actor gate;
 * requireWrite blocks viewers before that).
 */
export const DELETE = withRouteContext(
  'bank_file.undo',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ bankFileImportId: id })

    const result = await undoBankFileImport(supabase, companyId!, id, user.id)

    if (!result.success) {
      if (result.notFound) {
        // 404, not 400: the id names no import in this company (same
        // semantics as the SIE import routes' 'Import not found').
        return errorResponseFromCode('BANK_FILE_UNDO_NOT_FOUND', opLog, { requestId })
      }
      if (result.forbidden) {
        return errorResponseFromCode('BANK_FILE_UNDO_FORBIDDEN', opLog, { requestId })
      }
      return errorResponseFromCode('BANK_FILE_UNDO_FAILED', opLog, {
        requestId,
        details: { reason: result.error },
      })
    }

    opLog.info('bank file import undone', {
      actor: user.id,
      deletedTransactions: result.deletedTransactions,
      skippedBooked: result.skippedBooked,
      skippedMatchHistory: result.skippedMatchHistory,
    })

    return NextResponse.json({
      success: true,
      deletedTransactions: result.deletedTransactions,
      skippedBooked: result.skippedBooked,
      skippedMatchHistory: result.skippedMatchHistory,
    })
  },
  { requireWrite: true },
)
