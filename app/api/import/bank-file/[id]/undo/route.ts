import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyRole } from '@/lib/auth/require-write'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * DELETE /api/import/bank-file/[id]/undo
 *
 * Undo a bank-file import (#1672): bulk-deletes the batch's UNBOOKED
 * transactions, ignored rows included, via the undo_bank_file_import RPC.
 * Rows anchored to any verifikat (is_transaction_booked) are never deleted;
 * rows with payment_match_log history cannot be deleted either (append-only
 * per BFL 7:1). Both are skipped and reported in the response so the UI can
 * say exactly what was left in place. Owner/admin only (route-side gate for
 * a clean 403, re-enforced inside the RPC).
 *
 * Response: { data: { deleted, deleted_ignored, skipped_booked, skipped_matched } }
 */
export const DELETE = withRouteContext(
  'bank_file.undo',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ bankFileImportId: id })

    const roleCheck = await getCompanyRole(supabase, user.id)
    if (!roleCheck.ok || (roleCheck.role !== 'owner' && roleCheck.role !== 'admin')) {
      return errorResponseFromCode('BANK_FILE_UNDO_FORBIDDEN', opLog, { requestId })
    }

    const { data: importRecord } = await supabase
      .from('bank_file_imports')
      .select('id, status, imported_count')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!importRecord) {
      return errorResponseFromCode('BANK_FILE_UNDO_NOT_FOUND', opLog, { requestId })
    }

    if (importRecord.status !== 'completed' && importRecord.status !== 'failed') {
      return errorResponseFromCode('BANK_FILE_UNDO_BAD_STATUS', opLog, {
        requestId,
        details: { status: importRecord.status },
      })
    }

    // auth.uid() is present on the session client, but the actor is passed
    // explicitly anyway so the RPC's owner/admin gate never depends on the
    // client flavor (service clients resolve auth.uid() to NULL).
    const { data: report, error: rpcError } = await supabase.rpc('undo_bank_file_import', {
      p_company_id: companyId,
      p_import_id: id,
      p_user_id: user.id,
    })

    if (rpcError) {
      // The RPC refuses imports whose rows predate the provenance column:
      // it cannot know which transactions belong to the batch.
      if (/no linked transactions/i.test(rpcError.message)) {
        return errorResponseFromCode('BANK_FILE_UNDO_NO_LINK', opLog, { requestId })
      }
      if (/not in an undoable status/i.test(rpcError.message)) {
        return errorResponseFromCode('BANK_FILE_UNDO_BAD_STATUS', opLog, { requestId })
      }
      if (/owners and admins/i.test(rpcError.message)) {
        return errorResponseFromCode('BANK_FILE_UNDO_FORBIDDEN', opLog, { requestId })
      }
      opLog.error('undo_bank_file_import RPC failed', rpcError)
      return errorResponseFromCode('BANK_FILE_UNDO_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(rpcError) },
      })
    }

    const result = (report ?? {}) as {
      deleted?: number
      deleted_ignored?: number
      skipped_booked?: number
      skipped_matched?: number
    }

    opLog.info('bank file import undone', {
      deleted: result.deleted ?? 0,
      deletedIgnored: result.deleted_ignored ?? 0,
      skippedBooked: result.skipped_booked ?? 0,
      skippedMatched: result.skipped_matched ?? 0,
      actor: user.id,
    })

    return NextResponse.json({
      data: {
        deleted: result.deleted ?? 0,
        deleted_ignored: result.deleted_ignored ?? 0,
        skipped_booked: result.skipped_booked ?? 0,
        skipped_matched: result.skipped_matched ?? 0,
      },
    })
  },
  { requireWrite: true },
)
