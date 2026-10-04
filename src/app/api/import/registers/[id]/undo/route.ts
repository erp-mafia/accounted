import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { undoRegisterImport } from '@/lib/import/register-runs'
import { ensureInitialized } from '@/lib/init'

// The service client helper sits in the SIE import module, which can emit.
ensureInitialized()

// Deleting a few thousand imported rows (each checked against every table
// that can point at it) can outlast the default function timeout; same
// budget as the bank-file undo.
export const maxDuration = 300

const RunId = z.string().uuid()

/**
 * DELETE /api/import/registers/[id]/undo
 *
 * Undo a customer, supplier or article import: deletes the rows it created
 * that nothing uses yet and reports the rows it kept, with the reason. Rules
 * in the undo_register_import RPC (migration 20261004163415); any writer may
 * undo, as any writer may run the import.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'register_import.undo',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!RunId.safeParse(id).success) {
      return errorResponseFromCode('REG_IMPORT_UNDO_INVALID_ID', log, { requestId })
    }
    const opLog = log.child({ registerImportRunId: id })

    const outcome = await undoRegisterImport(supabase, companyId, id, user.id)
    if (!outcome.ok) {
      if (outcome.error) opLog.error('register import undo refused or failed', outcome.error)
      return errorResponseFromCode(outcome.code, opLog, { requestId })
    }

    opLog.info('register import undone', {
      deleted: outcome.result.deleted,
      kept: outcome.result.kept.length,
    })
    return NextResponse.json({ data: outcome.result })
  },
  { requireWrite: true },
)
