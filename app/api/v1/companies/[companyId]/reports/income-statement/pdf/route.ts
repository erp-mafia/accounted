/**
 * GET /api/v1/companies/{companyId}/reports/income-statement/pdf
 *
 * Render the resultaträkning as application/pdf, byte-equivalent to the
 * dashboard's PDF export. Supports the same optional `from_date` / `to_date`
 * range as the JSON endpoint, so an agent can fetch e.g. a January-July
 * report for bank requests without touching the web UI.
 */

import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  assertKnownQueryParams,
  loadPeriodFromQuery,
  loadRangeFromQuery,
  safeGenerate,
} from '@/lib/api/v1/report-period'
import { contentDisposition } from '@/lib/api/content-disposition'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { FinancialStatementPDF } from '@/lib/reports/financial-statement-pdf-template'
import { buildIncomeStatementPdfModel } from '@/lib/reports/financial-statement-pdf'
import type { CompanySettings } from '@/types'

const ALLOWED_PARAMS = ['period_id', 'from_date', 'to_date'] as const

registerEndpoint({
  operation: 'reports.income-statement.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/income-statement/pdf',
  summary: 'Income statement (resultaträkning) as a PDF.',
  description:
    'Renders the resultaträkning as application/pdf, byte-equivalent to the dashboard export. Optional `from_date` / `to_date` (YYYY-MM-DD, inside the fiscal period) narrow the report to a custom range. The filename carries the effective date range and an "utkast" suffix (the document is a working report, not a signed årsredovisning).',
  useWhen:
    'You need a presentable PDF of the profit/loss for a period or partial period: bank requests, board packs, or sharing outside Accounted.',
  doNotUseFor:
    'Machine-readable figures (use the JSON endpoint without /pdf). The formal K2/K3 årsredovisning document (use the year-end flow).',
  pitfalls: [
    '`period_id` is required; `from_date`/`to_date` are optional and must lie within that fiscal period.',
    'Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.',
    'The PDF is marked "utkast": it is a working report, not a fastställd årsredovisning.',
  ],
  example: {
    response: {
      _note: 'Returns application/pdf binary stream.',
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.unknown(), // Marker: binary response, see contentType.
    contentType: 'application/pdf',
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.income-statement.pdf',
  async (request, ctx) => {
    const params = await assertKnownQueryParams(request, ALLOWED_PARAMS, ctx)
    if (!params.ok) return params.response

    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const rangeResult = await loadRangeFromQuery(request, period.period, ctx)
    if (!rangeResult.ok) return rangeResult.response
    const range = rangeResult.range

    const { data: company, error: companyErr } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (companyErr) {
      return v1ErrorResponse(companyErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!company) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'company_settings' },
      })
    }

    const gen = await safeGenerate(
      () => generateIncomeStatement(ctx.supabase, ctx.companyId!, period.period.id, range),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'income-statement-pdf' },
    )
    if (!gen.ok) return gen.response

    const report = gen.result
    report.period = {
      start: range.fromDate ?? period.period.period_start,
      end: range.toDate ?? period.period.period_end,
    }

    const { groups, summary } = buildIncomeStatementPdfModel(report)

    let pdfBuffer: Buffer
    try {
      pdfBuffer = await renderToBuffer(
        FinancialStatementPDF({
          title: 'Resultaträkning',
          groups,
          summary,
          period: report.period,
          company: company as CompanySettings,
          generatedAt: new Date().toISOString(),
        }),
      )
    } catch (err) {
      ctx.log.error('reports.income-statement.pdf: render failed', err as Error, {
        companyId: ctx.companyId,
        periodId: period.period.id,
      })
      return v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { report: 'income-statement-pdf', reason: 'PDF rendering failed.' },
      })
    }

    // "-utkast" suffix keeps the draft status visible even after the file
    // leaves the client: complements the in-document ÅRL 2:7 disclaimer.
    const filename = `resultatrakning-${report.period.start}--${report.period.end}-utkast.pdf`

    return new Response(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('attachment', filename),
        'Content-Length': String(pdfBuffer.length),
        'Cache-Control': 'private, no-store',
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
