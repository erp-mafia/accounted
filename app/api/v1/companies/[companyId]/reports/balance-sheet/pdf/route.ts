/**
 * GET /api/v1/companies/{companyId}/reports/balance-sheet/pdf
 *
 * Render the balansräkning as application/pdf, byte-equivalent to the
 * dashboard's PDF export. Supports the same optional `as_of` (alias for
 * `to_date`) / `from_date` / `to_date` range as the JSON endpoint, so an
 * agent can fetch the balance position at e.g. the latest month-end.
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
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { FinancialStatementPDF } from '@/lib/reports/financial-statement-pdf-template'
import {
  buildBalanceSheetPdfModel,
  balanceSheetImbalanceKronor,
} from '@/lib/reports/financial-statement-pdf'
import type { CompanySettings } from '@/types'

const ALLOWED_PARAMS = ['period_id', 'from_date', 'to_date', 'as_of'] as const

registerEndpoint({
  operation: 'reports.balance-sheet.pdf',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/balance-sheet/pdf',
  summary: 'Balance sheet (balansräkning) as a PDF.',
  description:
    'Renders the balansräkning as application/pdf, byte-equivalent to the dashboard export. Optional `as_of` (alias for `to_date`, YYYY-MM-DD inside the fiscal period) returns the balance position at that date, e.g. the latest month-end for bank reporting. Refuses to render when tillgångar and eget kapital + skulder differ by a full krona or more.',
  useWhen:
    'You need a presentable PDF of the balance position at period end or a custom date: bank requests, board packs, or sharing outside Accounted.',
  doNotUseFor:
    'Machine-readable figures (use the JSON endpoint without /pdf). The formal K2/K3 årsredovisning document (use the year-end flow).',
  pitfalls: [
    '`period_id` is required; `as_of` / `from_date` / `to_date` are optional and must lie within that fiscal period. `as_of` and `to_date` are aliases: pass at most one.',
    'Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.',
    'An unbalanced balansräkning (>= 1 kr difference) returns REPORT_GENERATION_FAILED instead of a PDF: fix the imbalance first.',
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
  'reports.balance-sheet.pdf',
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

    const rangeResult = await loadRangeFromQuery(request, period.period, ctx, { asOfAlias: true })
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
      () => generateBalanceSheet(ctx.supabase, ctx.companyId!, period.period.id, range),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'balance-sheet-pdf' },
    )
    if (!gen.ok) return gen.response

    const report = gen.result
    report.period = {
      start: range.fromDate ?? period.period.period_start,
      end: range.toDate ?? period.period.period_end,
    }

    // Same gate as the dashboard export: ÅRL 3 kap requires balansräkningen
    // to balance; a PDF of an unbalanced one would misrepresent the books.
    if (balanceSheetImbalanceKronor(report) >= 1) {
      return v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          report: 'balance-sheet-pdf',
          reason:
            'Balansräkningen balanserar inte (tillgångar och eget kapital + skulder skiljer sig med minst 1 kr). Åtgärda differensen innan du genererar PDF.',
          total_assets: report.total_assets,
          total_equity_liabilities: report.total_equity_liabilities,
        },
      })
    }

    let pdfBuffer: Buffer
    try {
      pdfBuffer = await renderToBuffer(
        FinancialStatementPDF({
          title: 'Balansräkning',
          groups: buildBalanceSheetPdfModel(report).groups,
          period: report.period,
          company: company as CompanySettings,
          generatedAt: new Date().toISOString(),
        }),
      )
    } catch (err) {
      ctx.log.error('reports.balance-sheet.pdf: render failed', err as Error, {
        companyId: ctx.companyId,
        periodId: period.period.id,
      })
      return v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { report: 'balance-sheet-pdf', reason: 'PDF rendering failed.' },
      })
    }

    // "-utkast" suffix keeps the draft status visible even after the file
    // leaves the client: complements the in-document ÅRL 2:7 disclaimer.
    const filename = `balansrakning-${report.period.start}--${report.period.end}-utkast.pdf`

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
