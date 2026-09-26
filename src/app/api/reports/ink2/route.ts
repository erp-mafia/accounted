import { NextResponse } from 'next/server'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import {
  generateSRUSubmission,
  getZipFilename,
} from '@/lib/reports/ink2/sru-generator'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildSruZip } from '@/lib/reports/filing-report-service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/reports/ink2
 *
 * Query parameters:
 *   period_id: fiscal period id (required)
 *   format:    'json' (default) or 'sru' for SRU file download (ZIP with INFO.SRU + BLANKETTER.SRU)
 */
export const GET = withRouteContext(
  'report.ink2',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const format = searchParams.get('format') || 'json'

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const opLog = log.child({ periodId, format })

    try {
      const declaration = await generateINK2Declaration(supabase, companyId!, periodId)

      if (format === 'sru') {
        // The two SRU files, ISO 8859-1 and zipped: the same builder as the v1
        // /reports/ink2/sru download.
        const zipBytes = await buildSruZip(generateSRUSubmission(declaration))
        const filename = getZipFilename(declaration)

        return new NextResponse(new Uint8Array(zipBytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Request-Id': requestId,
          },
        })
      }

      return NextResponse.json({ data: declaration })
    } catch (err) {
      opLog.error('ink2 declaration generation failed', err as Error)
      return errorResponseFromCode('TAX_DECL_GENERATION_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  }, { requireCompleteLedger: (request) => new URL(request.url).searchParams.get('format') === 'sru' })
