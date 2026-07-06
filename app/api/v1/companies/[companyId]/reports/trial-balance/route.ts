/**
 * GET /api/v1/companies/{companyId}/reports/trial-balance
 *
 * Returns the trial-balance (huvudbok-summa) for a fiscal period: opening
 * balance + period debit + period credit + closing balance per active
 * account. Mirrors the dashboard report byte-equivalently: same `lib/reports/
 * trial-balance.ts` generator backs both surfaces.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

const TrialBalanceRow = z.object({
  account: z.string(),
  account_name: z.string(),
  opening_balance: z.number(),
  period_debit: z.number(),
  period_credit: z.number(),
  closing_balance: z.number(),
})

const TrialBalanceResponse = z.object({
  rows: z.array(TrialBalanceRow),
  totalDebit: z.number(),
  totalCredit: z.number(),
  isBalanced: z.boolean(),
})

registerEndpoint({
  operation: 'reports.trial-balance',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/trial-balance',
  summary: 'Trial balance (huvudboksrapport) for a fiscal period.',
  description:
    'Returns the per-account opening balance + period debit/credit + closing balance plus run-level totals and an `isBalanced` flag. The numbers come from the same `lib/reports/trial-balance.ts` generator the dashboard uses.',
  useWhen:
    'You need a snapshot of every active account\'s movement during a period: typically the first report an accountant checks before running balance sheet or income statement.',
  doNotUseFor:
    'Reconciliation against AR/AP (use /reports/ar-ledger or /supplier-ledger). Specific account drill-in (use /reports/general-ledger with account_from/account_to filters).',
  pitfalls: [
    '`period_id` is required as a query parameter.',
    '`isBalanced=false` means the period has unbalanced postings: a data-integrity red flag. The lib generator rounds at the source so a true imbalance is rare; investigate immediately.',
    'Closed/locked periods are still queryable: the report is read-only.',
  ],
  example: {
    response: {
      data: {
        rows: [
          { account: '1930', account_name: 'Företagskonto', opening_balance: 100000, period_debit: 25000, period_credit: 18000, closing_balance: 107000 },
        ],
        totalDebit: 25000,
        totalCredit: 25000,
        isBalanced: true,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(TrialBalanceResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.trial-balance',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const gen = await safeGenerate(
      () => generateTrialBalance(ctx.supabase, ctx.companyId!, period.period.id),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'trial-balance' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
