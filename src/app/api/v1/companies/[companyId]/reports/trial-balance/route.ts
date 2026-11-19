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
import {
  loadPeriodFromQuery,
  safeGenerate,
  ReportPeriodQueryShape,
} from '@/lib/api/v1/report-period'
import { generateTrialBalance } from '@/lib/reports/trial-balance'

// The generator's row, exactly as the handler returns it (lib/reports/
// trial-balance.ts, TrialBalanceRow). Each side is gross: closing = opening +
// period on that side, so the account's balance is closing_debit -
// closing_credit.
const TrialBalanceRow = z.object({
  account_number: z.string(),
  account_name: z.string(),
  account_class: z.number().int(),
  opening_debit: z.number(),
  opening_credit: z.number(),
  period_debit: z.number(),
  period_credit: z.number(),
  closing_debit: z.number(),
  closing_credit: z.number(),
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
    'Returns per account the opening (IB), period and closing (UB) debit and credit, each side gross (closing = opening + period on that side; the balance is closing_debit - closing_credit), plus totalDebit/totalCredit (sums of closing_debit and closing_credit) and an `isBalanced` flag. The numbers come from the same `lib/reports/trial-balance.ts` generator the dashboard uses.',
  useWhen:
    'You need a snapshot of every active account\'s movement during a period: typically the first report an accountant checks before running balance sheet or income statement.',
  doNotUseFor:
    'Reconciliation against AR/AP (use /reports/ar-ledger or /supplier-ledger). Specific account drill-in (use /reports/general-ledger with account_from/account_to filters).',
  pitfalls: [
    '`period_id` is required as a query parameter.',
    '`isBalanced=false` means the period has unbalanced postings: a data-integrity red flag. The lib generator rounds at the source so a true imbalance is rare; investigate immediately.',
    'Closed/locked periods are still queryable: the report is read-only.',
    'No dimension filter: the saldobalans is company-wide, so dim_no/dim_code answer 400 VALIDATION_ERROR rather than an unfiltered report. For one project or cost centre use /reports/income-statement or /reports/general-ledger with dim_no + dim_code.',
  ],
  example: {
    response: {
      data: {
        rows: [
          { account_number: '1930', account_name: 'Företagskonto', account_class: 1, opening_debit: 100000, opening_credit: 0, period_debit: 7000, period_credit: 3000, closing_debit: 107000, closing_credit: 3000 },
          { account_number: '2081', account_name: 'Aktiekapital', account_class: 2, opening_debit: 0, opening_credit: 100000, period_debit: 0, period_credit: 0, closing_debit: 0, closing_credit: 100000 },
          { account_number: '2611', account_name: 'Utgående moms på försäljning inom Sverige, 25 %', account_class: 2, opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 1400, closing_debit: 0, closing_credit: 1400 },
          { account_number: '3001', account_name: 'Försäljning inom Sverige, 25 % moms', account_class: 3, opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 5600, closing_debit: 0, closing_credit: 5600 },
          { account_number: '5010', account_name: 'Lokalhyra', account_class: 5, opening_debit: 0, opening_credit: 0, period_debit: 3000, period_credit: 0, closing_debit: 3000, closing_credit: 0 },
        ],
        totalDebit: 110000,
        totalCredit: 110000,
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
  request: { query: z.object({ ...ReportPeriodQueryShape }) },
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
      () => generateTrialBalance(ctx.supabase, ctx.companyId!, period.period.id, { closingEntry: 'include' }),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'trial-balance' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
