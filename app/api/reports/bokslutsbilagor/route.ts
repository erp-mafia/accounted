import { NextResponse } from 'next/server'
import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { generateBokslutsbilagor } from '@/lib/reports/bokslutsbilagor'
import { BokslutsbilagorPDF } from '@/lib/reports/bokslutsbilagor-pdf-template'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'
import { currentAppVersion } from '@/lib/reports/app-version'
import { slugifyCompanyName } from '@/lib/reports/xlsx-export'

const BokslutsbilagorQuerySchema = z.object({
  period_id: z.string().uuid(),
  format: z.enum(['json', 'pdf']).default('json'),
})

/**
 * GET /api/reports/bokslutsbilagor?period_id=&format=json|pdf
 *
 * The bokslutsbilagor pärm for one räkenskapsår: every balance account as of
 * the balansdag with balances, specification or stated balance, sign-off,
 * underlag files with hashes, and the checklist. Read-only; signer and
 * uploader labels resolve through a service-role lookup on `profiles`
 * restricted to the ids in the result, like behandlingshistorik.
 */
export const GET = withRouteContext('report.bokslutsbilagor', async (request, ctx) => {
  const { supabase, user, companyId, log, requestId } = ctx
  const query = validateQuery(request, BokslutsbilagorQuerySchema, { log, operation: 'report.bokslutsbilagor' })
  if (!query.success) return query.response
  const { period_id: periodId, format } = query.data

  try {
    const serviceClient = createServiceClient()
    const report = await generateBokslutsbilagor(supabase, companyId, periodId, {
      userId: user.id,
      resolveUserLabels: (ids) => resolveUserLabelsFromProfiles(serviceClient, ids),
      appVersion: currentAppVersion(),
    })
    if (!report) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })

    if (format === 'json') {
      return privateNoStore(NextResponse.json({ data: report }))
    }
    const pdf = await renderToBuffer(BokslutsbilagorPDF({ report }))
    const filename = `bokslutsbilagor-${slugifyCompanyName(report.company.name)}-${report.period.end.replace(/-/g, '')}.pdf`
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('attachment', filename),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    // Raw message stays server-side: it can carry table names / SQL.
    log.error('bokslutsbilagor generation failed', err as Error, { periodId })
    return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
  }
})
