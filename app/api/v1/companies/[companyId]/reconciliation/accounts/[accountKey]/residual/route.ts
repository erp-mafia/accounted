/**
 * POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/residual
 *
 * Book the remainder of a bank selection (N transactions vs one verifikat)
 * as a small verifikat (bank fee / interest / rounding) and link the
 * selection in the same call. Writes to the ledger: transactions:write, the
 * same scope that books a bank transaction. Dry-runnable; Idempotency-Key
 * required.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { bookResidualAndLink, ReconciliationResidualError, RESIDUAL_MAX_AMOUNT } from '@/lib/reconciliation/residual'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

const ResidualRequest = z.object({
  external_ids: z.array(z.string().uuid()).min(1).max(50),
  journal_entry_id: z.string().uuid(),
  kind: z.enum(['bank_fee', 'rounding', 'interest_income', 'interest_expense']),
  entry_date: z.string().regex(ISO_DATE_RE).optional(),
  description: z.string().max(200).optional(),
})

const LineSchema = z.object({ account_number: z.string(), debit_amount: z.number(), credit_amount: z.number() })

const ResidualResponse = z.object({
  dry_run: z.boolean(),
  residual_journal_entry_id: z.string().optional(),
  residual_amount: z.number().optional(),
  applied: z.array(z.object({ external_id: z.string(), journal_entry_id: z.string() })).optional(),
  skipped: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
  would_book: z
    .object({
      kind: z.string(),
      counter_account: z.string(),
      ledger_account: z.string(),
      currency: z.string(),
      transactions_total: z.number(),
      entry_net: z.number(),
      residual_amount: z.number(),
      entry_date: z.string(),
      description: z.string(),
      lines: z.array(LineSchema),
    })
    .optional(),
})

registerEndpoint({
  operation: 'reconciliation.accounts.residual',
  method: 'POST',
  path: '/api/v1/companies/:companyId/reconciliation/accounts/:accountKey/residual',
  summary: 'Book the remainder of a bank selection as a fee/interest/rounding verifikat and link the selection.',
  description:
    `Body: { external_ids: [transaction ids], journal_entry_id, kind: "bank_fee" | "interest_expense" | "interest_income" | "rounding", entry_date?, description? }. Computes the difference between the transactions' sum and the verifikat's net on the bank account, books it on 6570 / 8410 / 8310 / 3740 against the bank account (dated on the latest transaction by default), links the transactions to the main verifikat and anchors the residual verifikat through transaction_voucher_links. Bank accounts only (bank:<cash_account_id>). Refused when the difference is 0 (RESIDUAL_ZERO), above ${RESIDUAL_MAX_AMOUNT} kr (RESIDUAL_TOO_LARGE: that is a missing booking, not a fee), or when the kind points the wrong way (RESIDUAL_DIRECTION). ?dry_run=true returns would_book without writing.`,
  useWhen:
    'A manual match misses by a small amount that is genuinely a bank fee, interest or rounding, and you want to close it in one step instead of booking a verifikat and then linking.',
  doNotUseFor:
    'Skattekonto rows (Skatteverket posts ränta and avgifter as their own rows: link them), or differences that are really a missing booking (book that properly).',
  pitfalls: [
    'The kind must match the direction: money that left the bank unbooked is bank_fee / interest_expense; money that arrived unbooked is interest_income; rounding works either way.',
    'Links are made before the booking and undone if the booking is refused (a locked period), so a refusal leaves nothing half done.',
    'Idempotency-Key is required; repeating the same key replays the first response.',
  ],
  example: {
    request: { external_ids: ['22222222-2222-4222-8222-222222222222'], journal_entry_id: '44444444-4444-4444-8444-444444444444', kind: 'bank_fee' },
    response: {
      data: {
        dry_run: false,
        residual_journal_entry_id: '55555555-5555-4555-8555-555555555555',
        residual_amount: -10,
        applied: [{ external_id: '22222222-2222-4222-8222-222222222222', journal_entry_id: '44444444-4444-4444-8444-444444444444' }],
        skipped: [],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: false,
  reversible: false,
  dryRunSupported: true,
  request: { body: ResidualRequest },
  response: { success: dataEnvelope(ResidualResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; accountKey: string }> }>(
  'reconciliation.accounts.residual',
  async (request, ctx, params) => {
    const { accountKey } = await params.params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'accountKey', message: 'Okänt konto.' },
      })
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = ResidualRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    try {
      const result = await bookResidualAndLink(ctx.supabase, ctx.companyId!, ctx.userId, accountKey, parsed.data, {
        dryRun: ctx.dryRun,
      })
      if (!result) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'accountKey', message: 'Okänt konto för det här företaget.' },
        })
      }
      if (ctx.dryRun) {
        return dryRunPreview(result, { requestId: ctx.requestId, log: ctx.log })
      }
      return ok(result, { requestId: ctx.requestId })
    } catch (err) {
      if (err instanceof ReconciliationResidualError) {
        const v1Code =
          err.code === 'RESIDUAL_ROWS_NOT_FOUND' || err.code === 'RESIDUAL_ENTRY_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR'
        return v1ErrorResponseFromCode(v1Code, ctx.log, {
          requestId: ctx.requestId,
          details: { code: err.code, message: getErrorMessage(err) },
        })
      }
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
