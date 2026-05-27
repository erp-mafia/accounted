import { NextResponse } from 'next/server'
import { replaceSIEImport } from '@/lib/import/sie-import'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/import/sie/[id]/replace
 *
 * Replace a completed SIE import by hard-deleting its entries, allowing the
 * user to re-import corrected data for the same fiscal period.
 */
export const POST = withRouteContext(
  'sie_import.replace',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ sieImportId: id })

    const result = await replaceSIEImport(supabase, companyId!, id)

    if (!result.success) {
      return errorResponseFromCode('SIE_REPLACE_FAILED', opLog, {
        requestId,
        details: { reason: result.error },
      })
    }

    return NextResponse.json({ success: true, deletedEntries: result.deletedEntries })
  },
  { requireWrite: true },
)
