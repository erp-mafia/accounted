/**
 * GET /api/v1/companies/{companyId}/reports/balance-sheet
 *
 * Returns the balansrapport for a fiscal period: assets / liabilities /
 * equity broken into sections per BAS class. Mirrors the dashboard
 * generator (`lib/reports/balance-sheet.ts`).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'

// Use z.unknown for the rich nested shape: the lib types are stable and
// callers consume via `data.sections[…]`. Strict Zod schemas here would
// require importing every BAS-section type, which adds maintenance with no
// runtime benefit (the server is the source of truth, not the agent).
const BalanceSheetResponse = z.unknown()

registerEndpoint({
  operation: 'reports.balance-sheet',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/balance-sheet',
  summary: 'Balance sheet (balansräkning) for a fiscal period.',
  description:
    'Returns assets / liabilities / equity grouped into BAS sections, with the period\'s opening and closing balances. Sums match the income statement for the same period; the closing equity flows into next period\'s opening balance.',
  useWhen:
    'You need the company\'s balance position at period end: typically for management reporting, year-end review, or the K2/K3 årsredovisning uppställningsform.',
  doNotUseFor:
    'Per-account drill-down (use /reports/general-ledger). Net result for the period (use /reports/income-statement).',
  pitfalls: [
    '`period_id` is required.',
    'Balance sheet equity includes the period\'s computed result: recalculation happens on every call, so a freshly-posted entry is reflected immediately (no caching).',
  ],
  example: {
    response: {
      data: {
        period: { start: '2026-01-01', end: '2026-12-31' },
        sections: [],
        totals: {},
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(BalanceSheetResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.balance-sheet',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () => generateBalanceSheet(ctx.supabase, ctx.companyId!, period.period.id),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'balance-sheet' },
    )
    if (!gen.ok) return gen.response

    // The dashboard route enriches the result with the period dates; mirror.
    // The cast through `unknown` is the standard pattern for adding an
    // ad-hoc field to a structurally-typed lib return (BalanceSheetReport
    // doesn't formally include `period`, but the dashboard's behavior
    // attaches it).
    const result = gen.result as unknown as Record<string, unknown>
    result.period = { start: period.period.period_start, end: period.period.period_end }

    return ok(result, { requestId: ctx.requestId })
  },
)
