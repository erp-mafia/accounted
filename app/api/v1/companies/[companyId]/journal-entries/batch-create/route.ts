/**
 * POST /api/v1/companies/{companyId}/journal-entries/batch-create
 *
 * Bulk-create draft journal entries (up to 50 per call). Each item is
 * processed independently: per-item failures don't roll back successes
 * (partial-success semantics, matching /invoices/bulk-create and
 * /suppliers/bulk-create).
 *
 * The endpoint creates DRAFTS only: committing them is a separate per-id
 * call. This keeps batch behaviour symmetric with the single POST and makes
 * the failure modes simpler (no half-committed batches).
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { CreateJournalEntrySchema } from '@/lib/api/schemas'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import type { Logger } from '@/lib/logger'

const BulkRequest = z.object({
  journal_entries: z.array(CreateJournalEntrySchema).min(1).max(50),
  all_or_nothing: z.boolean().optional().default(false),
})

const BulkResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
})

const BulkResponse = z.object({
  results: z.array(BulkResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

registerEndpoint({
  operation: 'journal-entries.batch-create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/batch-create',
  summary: 'Create up to 50 draft journal entries (partial-success).',
  description:
    'Bulk-create endpoint mirroring /invoices/bulk-create and /suppliers/bulk-create. Each entry is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns DRAFTS only; commit each separately. Idempotent over the whole batch. Dry-runnable.',
  useWhen:
    'You\'re replaying historical bookkeeping from another system, or batching a set of manual verifikationer from a spreadsheet. Use dry-run first to validate the batch.',
  doNotUseFor:
    'Committing posted entries: use POST /{id}/commit per entry. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.',
  pitfalls: [
    'Idempotency-Key is mandatory and covers the WHOLE batch.',
    'all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.',
    'Each entry must balance independently. Per-item JOURNAL_ENTRY_NOT_BALANCED appears in the results array.',
  ],
  example: {
    request: {
      journal_entries: [
        {
          fiscal_period_id: 'a8f1…', entry_date: '2026-05-12', description: 'Bankavgift',
          lines: [
            { account_number: '6570', debit_amount: 50, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 50 },
          ],
        },
      ],
    },
    response: {
      data: {
        results: [{ ok: true, request_index: 0, data: { id: '0e9c…', status: 'draft' } }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BulkRequest },
  response: { success: dataEnvelope(BulkResponse) },
})

interface ResultItem {
  ok: boolean
  request_index: number
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

async function createOne(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  index: number,
  input: z.infer<typeof CreateJournalEntrySchema>,
  dryRun: boolean,
  log: Logger,
): Promise<ResultItem> {
  if (dryRun) {
    return {
      ok: true,
      request_index: index,
      data: {
        preview: {
          status: 'draft' as const,
          voucher_series: input.voucher_series ?? 'A',
          voucher_number: 0,
          fiscal_period_id: input.fiscal_period_id,
          entry_date: input.entry_date,
          description: input.description,
          lines: input.lines,
        },
      },
    }
  }
  try {
    const entry = await createDraftEntry(supabase, companyId, userId, input)
    return {
      ok: true,
      request_index: index,
      data: { id: entry.id, status: entry.status, voucher_series: entry.voucher_series, voucher_number: entry.voucher_number },
    }
  } catch (err) {
    if (isBookkeepingError(err)) {
      const e = err as { code?: string; message?: string; details?: unknown }
      return {
        ok: false,
        request_index: index,
        error: {
          code: e.code ?? 'BOOKKEEPING_DATABASE_ERROR',
          message: e.message ?? 'Engine error',
          details: e.details,
        },
      }
    }
    log.error('batch-create: createDraftEntry failed', err as Error, { request_index: index })
    return {
      ok: false,
      request_index: index,
      error: { code: 'BOOKKEEPING_DATABASE_ERROR', message: (err as Error).message ?? 'unknown' },
    }
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'journal-entries.batch-create',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = BulkRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const body = parsed.data

    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'all_or_nothing', message: 'all_or_nothing: true is not yet implemented.' },
      })
    }

    // Ownership pre-check on every distinct fiscal_period_id in the batch.
    // Bulk endpoints are particularly attractive for cross-tenant probing
    // (50 ids per call vs 1) so we batch-verify up front rather than per-
    // item. Any unknown id fails the entire batch with a structured error:
    // partial-success semantics only apply AFTER ownership is established.
    const uniquePeriodIds = Array.from(new Set(body.journal_entries.map((e) => e.fiscal_period_id)))
    for (const periodId of uniquePeriodIds) {
      if (!(await ownsFiscalPeriod(ctx.supabase, ctx.companyId!, periodId))) {
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'fiscal_period', field: 'fiscal_period_id', value: periodId },
        })
      }
    }

    const results: ResultItem[] = []
    for (let i = 0; i < body.journal_entries.length; i++) {
      results.push(await createOne(ctx.supabase, ctx.companyId!, ctx.userId, i, body.journal_entries[i], ctx.dryRun, ctx.log))
    }
    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    ctx.log.info('journal-entries.batch-create completed', { ...summary, dryRun: ctx.dryRun })

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
