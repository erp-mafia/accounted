import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { fileResponse, streamedBody } from '@/lib/api/file-response'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { estimateArchiveSize, streamFullArchive } from '@/lib/reports/full-archive-export'
import { authorizeDeletedCompanyExport } from '@/lib/company/deleted-company-export'

const log = createLogger('api/account/deleted-companies/archive')

export const runtime = 'nodejs'
// Same ceiling as /api/reports/full-archive: the ZIP streams as it is
// written, so years of underlag take minutes, not memory.
export const maxDuration = 800

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/account/deleted-companies/[id]/archive: the full archive (SIE4,
 * reports, verifikationer, underlag, registers, behandlingshistorik) of a
 * deleted company, read only, for 18 months after the deletion (terms 9.3
 * and 9.4). The same ZIP as /api/reports/full-archive with scope=all.
 * `?estimate=1` answers the size estimate instead.
 *
 * The company id comes from the path, so access is checked here and only
 * here: an owner or admin membership of a company that is deleted and whose
 * window is open. Anything else is 404, so the route says nothing about
 * companies the person never belonged to; a closed window is 410.
 * requireAuth() rather than withRouteContext: the company is deleted, so it
 * can never be the active company (see the list route).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user } = auth

  const { id: companyId } = await params
  if (!UUID_RE.test(companyId)) {
    return privateNoStore(errorResponseFromCode('NOT_FOUND', log, { reason: 'company id is not a uuid' }))
  }

  const service = createServiceClient()
  let access
  try {
    access = await authorizeDeletedCompanyExport(service, user.id, companyId)
  } catch (err) {
    return privateNoStore(errorResponse(err, log))
  }
  if (!access.ok) {
    if (access.reason === 'window_closed') {
      return privateNoStore(
        errorResponseFromCode('DELETED_COMPANY_EXPORT_CLOSED', log, {
          reason: `export window ended ${access.exportUntil}`,
          details: { export_until: access.exportUntil },
        }),
      )
    }
    log.warn('deleted company archive denied', { userId: user.id, companyId })
    return privateNoStore(errorResponseFromCode('NOT_FOUND', log, { reason: 'no deleted company to export' }))
  }

  const { searchParams } = new URL(request.url)
  if (searchParams.get('estimate') === '1') {
    try {
      const estimate = await estimateArchiveSize(service, companyId, 'all')
      return NextResponse.json({ data: estimate }, { headers: PRIVATE_NO_STORE_HEADERS })
    } catch (err) {
      log.error('deleted company archive estimate failed', err as Error, { userId: user.id, companyId })
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log))
    }
  }

  const filename = `arkiv_raderat_${companyId}_${todayIsoStockholm().replace(/-/g, '')}.zip`
  const logContext = { userId: user.id, companyId, filename, exportUntil: access.company.exportUntil }
  log.info('deleted company archive requested', logContext)

  const archive = streamFullArchive(service, companyId, { scope: 'all', include_documents: true })
  return fileResponse(
    streamedBody(archive, {
      onEnd: (sizeBytes) => log.info('deleted company archive generated', { ...logContext, sizeBytes }),
      onError: (err, bytesSent) =>
        log.error('deleted company archive generation failed', err as Error, { ...logContext, bytesSent }),
      onCancel: (bytesSent) => log.info('deleted company archive download cancelled', { ...logContext, bytesSent }),
    }),
    { filename, contentType: 'application/zip', cacheControl: 'private, no-store' },
  )
}
