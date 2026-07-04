/**
 * GET /api/v1/companies/{companyId}/reports/income-statement
 *
 * Returns the resultatrapport for a fiscal period: revenue / cost of
 * goods / operating expenses / financial items, ending in the net result.
 * Same generator as the dashboard.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateIncomeStatement } from '@/lib/reports/income-statement'

const IncomeStatementResponse = z.unknown()

registerEndpoint({
  operation: 'reports.income-statement',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/income-statement',
  summary: 'Income statement (resultatrapport) for a fiscal period.',
  description:
    'Returns the period\'s revenue and expenses grouped by BAS class with subtotals (gross margin, operating result, net result). The net result flows into the balance-sheet equity for the same period.',
  useWhen:
    'You need the company\'s profit/loss for a period: month-end management reporting, K2/K3 årsredovisning resultaträkning, or feeding KPI dashboards.',
  doNotUseFor:
    'Per-account drill (use /reports/general-ledger). VAT figures (use /reports/vat-declaration). Balance position (use /reports/balance-sheet).',
  pitfalls: [
    '`period_id` is required.',
    'Net result on the income statement equals the period\'s equity-line delta on the balance sheet: they\'re derived from the same posted entries.',
  ],
  example: {
    response: {
      data: { period: { start: '…', end: '…' }, sections: [], grossMargin: 0, netResult: 0 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(IncomeStatementResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.income-statement',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () => generateIncomeStatement(ctx.supabase, ctx.companyId!, period.period.id),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'income-statement' },
    )
    if (!gen.ok) return gen.response

    const result = gen.result as unknown as Record<string, unknown>
    result.period = { start: period.period.period_start, end: period.period.period_end }

    return ok(result, { requestId: ctx.requestId })
  },
)
