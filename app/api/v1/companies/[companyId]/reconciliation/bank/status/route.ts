/**
 * GET /api/v1/companies/{companyId}/reconciliation/bank/status
 *
 * Snapshot of bank reconciliation health: counts of matched / unmatched
 * transactions and GL lines for the requested window. Read-only, no
 * dry-run, no idempotency.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'

// Mirrors ReconciliationStatus from lib/reconciliation/bank-reconciliation.ts:
// the handler passes that object straight through. This schema previously
// documented a different, invented shape (matched_transactions, bank_balance,
// total_unmatched_amount, …) that the endpoint never returned; any client coded
// against it read undefined for every field except difference.
const StatusResponse = z.object({
  /** Sum of bank-feed transactions in the window (the bank side), excluding ignored rows. */
  bank_transaction_total: z.number(),
  /** Sum of ignored bank transactions in the window. Informational: not part of bank_transaction_total or difference. */
  ignored_transaction_total: z.number(),
  ignored_transaction_count: z.number().int(),
  /** Full ledger balance on the account incl. opening balance: matches the balance sheet. */
  gl_1930_balance: z.number(),
  /** Ledger movement excluding opening balance: what `difference` compares against. */
  gl_1930_period_movement: z.number(),
  gl_1930_opening_balance: z.number(),
  /** Net storno/correction activity in the window. Informational; included in the movement. */
  gl_1930_correction_adjustment: z.number(),
  /** bank_transaction_total minus gl_1930_period_movement: how far apart the two
   *  sides stand. Expected to be large mid-year; see unexplained_difference. */
  difference: z.number(),
  is_reconciled: z.boolean(),
  matched_count: z.number().int(),
  unmatched_transaction_count: z.number().int(),
  /** Sum of the unmatched bank transactions: one of the two components of difference. */
  unmatched_transaction_total: z.number(),
  unmatched_gl_line_count: z.number().int(),
  /** Sum of the unmatched ledger lines, signed like a bank movement. null on a
   *  foreign account, whose candidate lines carry no amount in that currency. */
  unmatched_gl_line_total: z.number().nullable(),
  /** difference - unmatched_transaction_total + unmatched_gl_line_total: what is
   *  left once both work lists are accounted for. null when the GL total is. */
  unexplained_difference: z.number().nullable(),
})

registerEndpoint({
  operation: 'reconciliation.bank.status',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reconciliation/bank/status',
  summary: 'Bank-reconciliation health snapshot.',
  description:
    'Returns matched / unmatched counts and the balance delta between the bank ledger and the GL for the requested window. Optional ?date_from / ?date_to (default: company history).',
  useWhen:
    'You\'re building a dashboard widget, an audit report, or a pre-close check that needs to know how many bank transactions are still unbooked.',
  doNotUseFor:
    'Running the matcher: that\'s POST `/reconciliation/bank/run`. Per-transaction detail: use the transaction list with `?status=unbooked`.',
  pitfalls: [
    'A non-zero difference is normal between sync runs (uncleared cheques, in-flight transfers). Investigate only if it persists across reconciliations.',
    'difference compares against gl_1930_period_movement (movement excl. opening balance), NOT gl_1930_balance. Do not display gl_1930_balance next to difference.',
    'is_reconciled means |difference| < 0.01 for the window, an aggregate check, not a per-transaction guarantee.',
    'Judge health on unexplained_difference, NOT on difference. difference is just the gap between the two sides and is expected to be large mid-year; it is fully explained while every krona of it sits in unmatched_transaction_total or unmatched_gl_line_total. A non-zero unexplained_difference is the real finding: a matched pair disagreeing in amount, a voucher with several lines on the account, or a storno/correction line the candidate list hides.',
    'Ignored transactions are excluded from bank_transaction_total and difference (they never get a ledger counterpart); their count and sum are reported separately.',
  ],
  example: {
    response: {
      data: {
        bank_transaction_total: 48150,
        ignored_transaction_total: 0,
        ignored_transaction_count: 0,
        gl_1930_balance: 98150,
        gl_1930_period_movement: 48150,
        gl_1930_opening_balance: 50000,
        gl_1930_correction_adjustment: 0,
        difference: 0,
        is_reconciled: true,
        matched_count: 142,
        unmatched_transaction_count: 3,
        unmatched_transaction_total: 1250,
        unmatched_gl_line_count: 2,
        unmatched_gl_line_total: 1250,
        unexplained_difference: 0,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(StatusResponse) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reconciliation.bank.status',
  async (request, ctx) => {
    const url = new URL(request.url)
    const Filters = z.object({
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Settlement account (BAS code), e.g. '1930' / '1932'. Defaults to 1930.
      account_number: z.string().regex(/^\d{4}$/).optional(),
    })
    const parsed = Filters.safeParse({
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
      account_number: url.searchParams.get('account_number') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const accountNumber = parsed.data.account_number ?? '1930'
    const { data: cashAccount } = await ctx.supabase
      .from('cash_accounts')
      .select('id, currency, is_primary')
      .eq('company_id', ctx.companyId!)
      .eq('ledger_account', accountNumber)
      .maybeSingle()
    if (!cashAccount && accountNumber !== '1930') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [{ field: 'account_number', message: 'Okänt kassakonto för det här företaget' }],
        },
      })
    }

    try {
      const status = await getReconciliationStatus(
        ctx.supabase,
        ctx.companyId!,
        parsed.data.date_from,
        parsed.data.date_to,
        accountNumber,
        (cashAccount?.currency as string | undefined) ?? 'SEK',
        cashAccount?.id as string | undefined,
        // Only the primary account claims unassigned (NULL cash_account_id) rows.
        Boolean(cashAccount?.is_primary),
      )
      return ok(status, { requestId: ctx.requestId })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
)
