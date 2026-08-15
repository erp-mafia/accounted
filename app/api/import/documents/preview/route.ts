import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UnderlagImportPreviewSchema } from '@/lib/api/schemas'
import { buildUnderlagPlan } from '@/lib/documents/underlag-import'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/import/documents/preview: plan which verifikat each underlag file
 * belongs to, from the voucher reference in its filename.
 *
 * Read-only by construction. Only the NAMES are sent, so a user can review the
 * whole plan (including the misses) before a single byte is uploaded, and
 * before a single irreversible link is written.
 */
export const POST = withRouteContext('import.documents.preview', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const validation = await validateBody(request, UnderlagImportPreviewSchema)
  if (!validation.success) return validation.response

  try {
    const plan = await buildUnderlagPlan(supabase, companyId!, validation.data.file_names)
    return NextResponse.json({ data: plan })
  } catch (err) {
    log.error('underlag import preview failed', err as Error, {
      fileCount: validation.data.file_names.length,
    })
    return errorResponse(err, log, { requestId })
  }
})
