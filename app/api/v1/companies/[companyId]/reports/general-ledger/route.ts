/**
 * GET /api/v1/companies/{companyId}/reports/general-ledger
 *
 * Per-account journal-line ledger (huvudbok). Returns every posted line in
 * the period grouped by account, with running balances. Accepts
 * `account_from`/`account_to` to drill into a range.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'

const GeneralLedgerResponse = z.unknown()

registerEndpoint({
  operation: 'reports.general-ledger',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/general-ledger',
  summary: 'General ledger (huvudbok) for a fiscal period.',
  description:
    'Returns every posted journal line in the period grouped by account, with opening / running / closing balances. Supports optional `account_from` and `account_to` query parameters to limit the report to an account range (e.g. ?account_from=3000&account_to=3999 for revenue-only).',
  useWhen:
    'You\'re reconciling a specific account or range (bank account drilldown, revenue audit, expense investigation) and need every voucher-line that hit the account.',
  doNotUseFor:
    'Period totals only (use /reports/trial-balance). Specific transaction lookup (use /journal-entries/{id}).',
  pitfalls: [
    '`period_id` is required.',
    'Account ranges are inclusive on both bounds. `account_from=3000` includes 3000; `account_to=3999` includes 3999.',
    'Lines with `status != \'posted\'` (drafts, reversed) are excluded.',
  ],
  example: {
    response: {
      data: { period: {}, accounts: [] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(GeneralLedgerResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.general-ledger',
  async (request, ctx) => {
    const url = new URL(request.url)
    const accountFrom = url.searchParams.get('account_from') || undefined
    const accountTo = url.searchParams.get('account_to') || undefined

    // BAS account numbers are 4 digits today but extensible to 5 / 6 in
    // sub-account schemes (kostställen). Pattern allows 3-8 to leave room
    // without accepting arbitrary strings. OWASP V2.2: bound the values
    // before they reach the report generator's downstream queries.
    const accountRe = /^\d{3,8}$/
    if (accountFrom && !accountRe.test(accountFrom)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'account_from', message: 'Expected 3-8 digit account number.' },
      })
    }
    if (accountTo && !accountRe.test(accountTo)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'account_to', message: 'Expected 3-8 digit account number.' },
      })
    }

    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () =>
        generateGeneralLedger(
          ctx.supabase,
          ctx.companyId!,
          period.period.id,
          accountFrom,
          accountTo,
        ),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'general-ledger' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
