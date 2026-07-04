import { NextResponse } from 'next/server'
import { undoSIEImport } from '@/lib/import/sie-import'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// Hard-deleting a large import (thousands of audit-logged journal entries +
// cascading lines) can take well over the default function timeout. Match the
// SIE execute route so the serverless function doesn't kill the request first.
export const maxDuration = 300

/**
 * DELETE /api/import/sie/[id]/undo
 *
 * Undo a completed SIE import: hard-deletes all journal entries created
 * by the import (transaction vouchers + the opening_balance entry),
 * detaches any user-attached documents, resets voucher_sequences, and
 * marks the sie_imports row as 'undone'. Period must be open and not
 * locked. Owner/admin only (enforced by the RPC).
 */
export const DELETE = withRouteContext(
  'sie_import.undo',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ sieImportId: id })

    const result = await undoSIEImport(supabase, companyId!, id, user.id)

    if (!result.success) {
      return errorResponseFromCode('SIE_UNDO_FAILED', opLog, {
        requestId,
        details: { reason: result.error },
      })
    }

    return NextResponse.json({ success: true, deletedEntries: result.deletedEntries })
  },
  { requireWrite: true },
)
