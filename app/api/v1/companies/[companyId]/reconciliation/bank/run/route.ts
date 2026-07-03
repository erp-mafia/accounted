/**
 * POST /api/v1/companies/{companyId}/reconciliation/bank/run
 *
 * Run the bank-reconciliation pipeline: look for bank-side transactions and
 * GL-side journal lines that pair up by amount + date proximity, then apply
 * the matches (set `transactions.journal_entry_id` for confirmed pairs).
 *
 * Dry-run returns the proposed matches without applying any of them — the
 * canonical way to preview a reconciliation before letting it write to the
 * ledger. Idempotent via mandatory Idempotency-Key.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { runReconciliation } from '@/lib/reconciliation/bank-reconciliation'

const RunRequest = z
  .object({
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // Settlement account (BAS code) to reconcile against, e.g. '1930' (SEK) or
    // '1932' (EUR). Defaults to '1930'. Required for multi-account companies to
    // reconcile anything other than their primary SEK account.
    account_number: z.string().regex(/^\d{4}$/).optional(),
  })
  // Bound the window so a key with no explicit range can't trigger an
  // unbounded join across years. 366 days covers a full räkenskapsår + a
  // leap day; longer reconciliations should be paged.
  .refine(
    (d) => {
      if (!d.date_from || !d.date_to) return true
      const ms = new Date(d.date_to).getTime() - new Date(d.date_from).getTime()
      return ms >= 0 && ms <= 366 * 24 * 60 * 60 * 1000
    },
    { message: 'date range must be ≤ 366 days; page longer reconciliations.' },
  )

const MatchOut = z.object({
  transaction_id: z.string().uuid(),
  transaction_date: z.string(),
  transaction_description: z.string().nullable(),
  transaction_amount: z.number(),
  journal_entry_id: z.string().uuid(),
  voucher_number: z.number().int().nullable(),
  voucher_series: z.string().nullable(),
  entry_date: z.string(),
  entry_description: z.string().nullable(),
  method: z.string(),
  confidence: z.number(),
})

const RunResponse = z.object({
  matches: z.array(MatchOut),
  applied: z.number().int(),
  // Count of matches that failed to apply (DB error or lost an optimistic-lock
  // race). Documented as z.array(z.string()) until 2026-07 — the lib has always
  // returned a number.
  errors: z.number().int(),
})

registerEndpoint({
  operation: 'reconciliation.bank.run',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/bank/run',
  summary: 'Run the bank-reconciliation matcher.',
  description:
    'Walks all unbooked bank transactions in the requested date range and pairs them with open GL lines (1930-side) by amount + date proximity. Applies confirmed matches by setting transactions.journal_entry_id (the GL row already exists). Dry-runnable.',
  useWhen:
    'You want to auto-match outstanding bank transactions against existing journal entries — typically as the closing step of a sync. Dry-run first to inspect proposed matches.',
  doNotUseFor:
    'Creating new journal entries — this only links bank transactions to existing GL lines. Matching to invoices — use `:match-invoice` or `:match-supplier-invoice` for explicit invoice payments.',
  pitfalls: [
    'date_from / date_to default to the company\'s full bank history if omitted. Specify a window for predictable performance.',
    'account_number defaults to 1930. Multi-account companies must pass the BAS code of the account they are reconciling (e.g. 1932 for a EUR account), or it silently reconciles 1930.',
    'Idempotency-Key is mandatory.',
    'A non-dry run applies EVERY match found, including fuzzy ones at confidence 0.75 — there is no internal confidence threshold. Dry-run first and review matches.confidence before applying.',
    'The 366-day window bound only applies when BOTH date_from and date_to are set; a single-sided or absent window scans full history.',
  ],
  example: {
    request: { date_from: '2026-05-01', date_to: '2026-05-31' },
    response: {
      data: { matches: [], applied: 0, errors: 0 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: RunRequest },
  response: { success: dataEnvelope(RunResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reconciliation.bank.run',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      // Body is optional — an empty body is fine.
      rawBody = {}
    }
    const parsed = RunRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    // Resolve the settlement account to its cash account (currency + id) so the
    // matcher scopes transactions to this exact account, not every same-currency
    // account. The default '1930' is exempt from the existence check — it falls
    // back to currency-only scoping, matching the status endpoint and the
    // pre-feature behaviour. A non-default unknown account is rejected.
    const accountNumber = body.account_number ?? '1930'
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

    let result
    try {
      result = await runReconciliation(ctx.supabase, ctx.companyId!, ctx.userId, {
        dateFrom: body.date_from,
        dateTo: body.date_to,
        accountNumber,
        currency: (cashAccount?.currency as string | undefined) ?? 'SEK',
        cashAccountId: cashAccount?.id as string | undefined,
        // Only the primary account claims unassigned (NULL cash_account_id) rows.
        includeUnassigned: Boolean(cashAccount?.is_primary),
        dryRun: ctx.dryRun,
      })
    } catch (err) {
      ctx.log.error('reconciliation.bank.run: pipeline failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    const matches = result.matches.map((m) => ({
      transaction_id: m.transaction.id,
      transaction_date: m.transaction.date,
      transaction_description: m.transaction.description ?? null,
      transaction_amount: m.transaction.amount,
      journal_entry_id: m.glLine.journal_entry_id,
      voucher_number: m.glLine.voucher_number ?? null,
      voucher_series: m.glLine.voucher_series ?? null,
      entry_date: m.glLine.entry_date,
      entry_description: m.glLine.entry_description ?? null,
      method: m.method,
      confidence: m.confidence,
    }))

    const payload = {
      matches,
      applied: result.applied,
      errors: result.errors,
    }

    if (ctx.dryRun) {
      return dryRunPreview(payload, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok(payload, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
