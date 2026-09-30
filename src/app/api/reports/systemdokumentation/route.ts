import { NextResponse } from 'next/server'
import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { generateSystemdokumentation } from '@/lib/reports/systemdokumentation'
import { SystemdokumentationPDF } from '@/lib/reports/systemdokumentation-pdf-template'
import { resolveUserLabelsFromProfiles } from '@/lib/reports/behandlingshistorik'
import { currentAppVersion } from '@/lib/reports/app-version'
import { recordAppRelease } from '@/lib/reports/app-releases'
import { slugifyCompanyName } from '@/lib/reports/xlsx-export'

const SystemdokumentationQuerySchema = z.object({
  period_id: z.string().uuid(),
  format: z.enum(['json', 'pdf']).default('json'),
})

/**
 * GET /api/reports/systemdokumentation?period_id=&format=json|pdf
 *
 * Systemdokumentation (BFL 5 kap. 11 §, BFNAR 2013:2 kap. 9) for one
 * räkenskapsår, generated from the company's actual configuration.
 * Read-only. Member labels resolve through a service-role lookup on
 * `profiles` restricted to the member ids, and the API-key list through the
 * same service client (api_keys RLS is self-only), both like
 * behandlingshistorik and bokslutsbilagor.
 */
export const GET = withRouteContext('report.systemdokumentation', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const query = validateQuery(request, SystemdokumentationQuerySchema, { log, operation: 'report.systemdokumentation' })
  if (!query.success) return query.response
  const { period_id: periodId, format } = query.data

  try {
    const serviceClient = createServiceClient()
    // Date the running build in app_releases (p. 9.16: program versions).
    // Fire and forget: the helper never throws and is a no-op once recorded.
    void recordAppRelease(serviceClient)
    const report = await generateSystemdokumentation(supabase, companyId, periodId, {
      resolveUserLabels: (ids) => resolveUserLabelsFromProfiles(serviceClient, ids),
      serviceClient,
      appVersion: currentAppVersion(),
    })
    if (!report) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })

    if (format === 'json') {
      return privateNoStore(NextResponse.json({ data: report }))
    }
    const pdf = await renderToBuffer(SystemdokumentationPDF({ report }))
    const filename = `systemdokumentation-${slugifyCompanyName(report.company.name ?? 'foretag')}-${report.period.end.replace(/-/g, '')}.pdf`
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('attachment', filename),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    // Raw message stays server-side: it can carry table names / SQL.
    log.error('systemdokumentation generation failed', err as Error, { periodId })
    return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
  }
})
