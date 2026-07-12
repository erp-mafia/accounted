/**
 * GET /api/v1/companies/{companyId}/reports/journal-register
 *
 * The verifikationsregister: every committed journal entry in the period
 * with all its lines. Mirrors the dashboard generator.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateJournalRegister } from '@/lib/reports/journal-register'

registerEndpoint({
  operation: 'reports.journal-register',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/journal-register',
  summary: 'Journal register (verifikationsregister) for a fiscal period.',
  description:
    'Returns every committed journal entry in the period with its voucher number, date, description, and complete debit/credit line set. The canonical compliance report: what an accountant or Skatteverket audit would pull as proof of every booking.',
  useWhen:
    'You need the BFL-required register of all verifikationer for a period: typically for an audit, year-end review, or feeding an external accountant\'s tooling.',
  doNotUseFor:
    'Per-account drilldown (use /reports/general-ledger). Aggregate totals only (use /reports/trial-balance).',
  pitfalls: [
    '`period_id` is required.',
    'Output includes every line of every entry: large periods produce large responses. Consider paginating client-side or filtering by date range via /journal-entries list if you only need a slice.',
    'Reversed entries appear with status `reversed`; the original they reversed also remains.',
  ],
  example: {
    response: {
      data: { period: {}, entries: [] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.unknown()) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.journal-register',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () => generateJournalRegister(ctx.supabase, ctx.companyId!, period.period.id),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'journal-register' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
