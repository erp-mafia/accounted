/**
 * POST /api/v1/companies/{companyId}/transactions/batch-categorize
 *
 * Apply a single categorization to up to 100 transactions in one call.
 * Partial-success semantics: per-item failure does not roll back items that
 * succeeded. Each item is one call of categorizeTransaction
 * (lib/transactions/categorize-core.ts), the service behind :categorize and
 * the dashboard, so an item accepts the same fields and fails for the same
 * reasons with the same codes, including both double-booking guards
 * (TRANSACTION_BOOK_POSSIBLE_DUPLICATE with the bound force override;
 * TX_CATEGORIZE_SUGGEST_SI_MATCH / _CI_MATCH with confirm_no_match). Like the
 * other bulk booking drivers, an item never dedupes against a verifikat booked
 * earlier in the same batch.
 *
 * Idempotent over the whole batch. Dry-runnable.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import { chartVatTreatmentsLoader } from '@/lib/bookkeeping/chart-vat-treatments'
import { snapshotSuggestions } from '@/lib/suggestion-log/record'
import { categorizeTransaction, type CategorizeOutcome } from '@/lib/transactions/categorize-core'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const BatchItem = z.object({
  transaction_id: z.string().uuid(),
  categorization: CategorizeTransactionSchema,
})

const BatchRequest = z.object({
  items: z.array(BatchItem).min(1).max(100),
  all_or_nothing: z.boolean().optional().default(false),
})

const ResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  transaction_id: z.string().uuid(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
})

const BatchResponse = z.object({
  results: z.array(ResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

registerEndpoint({
  operation: 'transactions.batch-categorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/batch-categorize',
  summary: 'Categorize up to 100 transactions in one call (partial-success).',
  description:
    'Per-item categorization mirroring the single :categorize endpoint. Same `{ results, summary }` shape as the other bulk endpoints. all_or_nothing: true returns 501 NOT_IMPLEMENTED. Idempotent over the whole batch.',
  useWhen:
    'You have many transactions to categorize with the same logic (e.g. apply a booking template across a queue, mark a batch as private, override accounts on a series).',
  doNotUseFor:
    'Categorizing transactions with mixed logic: make multiple :categorize calls. Auto-categorization via templates: handled inside `ingest` for matching rows, no separate endpoint needed.',
  pitfalls: [
    'Max 100 items per call. Sequential processing.',
    'Idempotency-Key covers the WHOLE batch: replays return the cached full response.',
    'all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.',
    'Per item, the same double-booking guards as `:categorize`: TRANSACTION_BOOK_POSSIBLE_DUPLICATE (the ledger already books that bank line; override per item with `force: true` plus the echoed `expected_duplicate_journal_entry_id` / `expected_duplicate_transaction_id`) and TX_CATEGORIZE_SUGGEST_SI_MATCH / TX_CATEGORIZE_SUGGEST_CI_MATCH (an open invoice covers a plain 244x / 151x categorization; override with `confirm_no_match: true`). An item never dedupes against a verifikat booked earlier in the same batch.',
  ],
  example: {
    request: {
      items: [
        { transaction_id: 'tx_1', categorization: { is_business: true, category: 'expense_office' } },
      ],
    },
    response: {
      data: {
        results: [{ ok: true, request_index: 0, transaction_id: 'tx_1', data: { journal_entry_id: 'je_…' } }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BatchRequest },
  response: { success: dataEnvelope(BatchResponse) },
})

interface Item {
  ok: boolean
  request_index: number
  transaction_id: string
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

/** One item's outcome in the batch's result shape. */
function itemFromOutcome(index: number, transactionId: string, outcome: CategorizeOutcome): Item {
  if (!outcome.ok) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: outcome.code,
        message:
          outcome.message?.sv ??
          getErrorEntry(outcome.code)?.message_sv ??
          'Transaktionen bokfördes inte: se felkoden och detaljerna.',
        ...(outcome.details ? { details: outcome.details } : {}),
      },
    }
  }
  if (outcome.dryRun) {
    const { preview } = outcome
    return {
      ok: true,
      request_index: index,
      transaction_id: transactionId,
      data: {
        preview: {
          category: preview.category,
          debit_account: preview.mappingResult.debit_account,
          credit_account: preview.mappingResult.credit_account,
          vat_lines: preview.mappingResult.vat_lines,
          would_create_journal_entry: preview.would_create_journal_entry,
        },
      },
    }
  }
  const { booked } = outcome
  return {
    ok: true,
    request_index: index,
    transaction_id: transactionId,
    data: booked.already_had_journal_entry
      ? {
          journal_entry_created: false,
          journal_entry_id: booked.journal_entry_id,
          category: booked.category,
          already_had_journal_entry: true,
        }
      : {
          journal_entry_created: booked.journal_entry_created,
          journal_entry_id: booked.journal_entry_id,
          // Always null: a failed verifikat is a per-item refusal (#1947).
          // Kept for response-shape compatibility.
          journal_entry_error: null,
          category: booked.category,
        },
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'transactions.batch-categorize',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const parsed = BatchRequest.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'all_or_nothing',
          message: 'Use partial-success semantics (omit the flag or pass false).',
        },
      })
    }

    const results: Item[] = []
    // Transactions and verifikat booked so far in THIS batch. Passed to the
    // next item's duplicate guard so distinct bank movements the caller
    // listed that share (date, amount, account) never dedupe against each
    // other's fresh verifikat; a duplicate that existed before the batch is
    // in neither list and is still refused.
    const bookedTransactionIds: string[] = []
    const bookedJournalEntryIds: string[] = []
    const loadChart = chartVatTreatmentsLoader(ctx.supabase, ctx.companyId!)
    // One snapshot for the whole batch, before any row is booked: the
    // learning after one booking must not reach the next row's suggestions.
    const suggestionSnapshot = ctx.dryRun
      ? undefined
      : await snapshotSuggestions(ctx.supabase, ctx.companyId!, body.items.map((item) => item.transaction_id))
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]
      let r: Item
      try {
        const outcome = await categorizeTransaction(
          ctx.supabase,
          ctx.userId,
          ctx.companyId!,
          item.transaction_id,
          item.categorization,
          {
            dryRun: ctx.dryRun,
            onBooked: 'update_flags',
            forceVia: 'api_force',
            exclude: {
              excludeTransactionIds: [...bookedTransactionIds],
              excludeJournalEntryIds: [...bookedJournalEntryIds],
            },
            loadChart,
            suggestionSnapshot,
            log: ctx.log.child({ request_index: i }),
          },
        )
        r = itemFromOutcome(i, item.transaction_id, outcome)
      } catch (err) {
        // An unexpected failure of one item never fails the batch.
        ctx.log.error('batch-categorize: item failed', err as Error, { request_index: i })
        r = {
          ok: false,
          request_index: i,
          transaction_id: item.transaction_id,
          error: { code: getStructuredError(err).code, message: getErrorMessage(err, { context: 'transaction' }) },
        }
      }
      results.push(r)
      const booked = r.data as { journal_entry_created?: boolean; journal_entry_id?: string | null } | undefined
      if (r.ok && booked?.journal_entry_created && booked.journal_entry_id) {
        bookedTransactionIds.push(r.transaction_id)
        bookedJournalEntryIds.push(booked.journal_entry_id)
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
