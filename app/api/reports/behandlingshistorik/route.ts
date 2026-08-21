import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { BehandlingshistorikQuerySchema } from '@/lib/api/schemas'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  buildBehandlingshistorikExport,
  generateBehandlingshistorik,
  resolveUserLabelsFromProfiles,
} from '@/lib/reports/behandlingshistorik'

/**
 * GET /api/reports/behandlingshistorik
 *
 * Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16) for one fiscal
 * period, optionally narrowed to a date sub-range inside it.
 *
 * Query: period_id (required), from_date / to_date (optional, inside the
 * period), category (optional), format=json|csv|xlsx (default json).
 *
 * Read-only: the report is a view over journal_entries, the trigger-written
 * audit_log, the rättelse log and the import tables. Actor e-mails are
 * resolved through a service-role lookup on `profiles` (self-only RLS),
 * restricted to the user ids that appear in the result.
 */

/** Running build identifier, stamped on the report (p. 9.16: program version). */
function currentAppVersion(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_ID || ''
  return sha ? sha.slice(0, 12) : null
}

export const GET = withRouteContext('report.behandlingshistorik', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const query = validateQuery(request, BehandlingshistorikQuerySchema, {
    log,
    operation: 'report.behandlingshistorik',
  })
  if (!query.success) return query.response
  const { period_id: periodId, from_date, to_date, format, category } = query.data

  // Validate the optional sub-range against the period bounds (same contract
  // as the other fiscal-range reports). Unknown period: 404.
  if (from_date || to_date) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!period) {
      return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    }
    const { searchParams } = new URL(request.url)
    const parsed = parseReportDateRange(searchParams, period as { period_start: string; period_end: string })
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
  }

  try {
    const serviceClient = createServiceClient()
    const report = await generateBehandlingshistorik(
      supabase,
      companyId,
      {
        periodId,
        fromDate: from_date,
        toDate: to_date,
        categories: category ? [category] : undefined,
      },
      {
        resolveUserLabels: (ids) => resolveUserLabelsFromProfiles(serviceClient, ids),
        appVersion: currentAppVersion(),
      },
    )
    if (!report) {
      return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    }

    if (format === 'json') {
      return privateNoStore(NextResponse.json({ data: report }))
    }

    const file = buildBehandlingshistorikExport(report, format)
    return new NextResponse(new Uint8Array(file.buffer), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': contentDisposition('attachment', file.filename),
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    // Raw message stays server-side: it can carry table names / SQL.
    log.error('behandlingshistorik generation failed', err as Error, { periodId })
    return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
  }
})
