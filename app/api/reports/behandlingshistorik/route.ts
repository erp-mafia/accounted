import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { BehandlingshistorikQuerySchema } from '@/lib/api/schemas'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { currentAppVersion } from '@/lib/reports/app-version'
import { slugifyCompanyName } from '@/lib/reports/xlsx-export'
import {
  buildBehandlingshistorikExport,
  generateBehandlingshistorik,
  resolveUserLabelsFromProfiles,
} from '@/lib/reports/behandlingshistorik'
import { BehandlingshistorikPDF } from '@/lib/reports/behandlingshistorik-pdf-template'

/**
 * @react-pdf/renderer lays out every row on the CPU (measured ~25 ms per event
 * on a 371-event year); beyond this many events the render approaches the
 * function timeout. Larger years are served as CSV/XLSX (complete, instant)
 * and the PDF is refused with 413.
 */
export const PDF_EVENT_LIMIT = 4000

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

    if (format === 'pdf') {
      if (report.total_events > PDF_EVENT_LIMIT) {
        return errorResponseFromCode('REPORT_PDF_TOO_LARGE', log, { requestId })
      }
      const pdf = await renderToBuffer(BehandlingshistorikPDF({ report }))
      const date = report.mode === 'fiscal_year' ? report.period.end : report.range.to
      const filename = `behandlingshistorik-${slugifyCompanyName(report.company.name)}-${date.replace(/-/g, '')}.pdf`
      return new NextResponse(new Uint8Array(pdf), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': contentDisposition('attachment', filename),
          'Cache-Control': 'private, no-store',
        },
      })
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
