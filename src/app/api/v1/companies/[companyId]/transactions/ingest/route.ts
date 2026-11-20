/**
 * POST /api/v1/companies/{companyId}/transactions/ingest
 *
 * Bulk-ingest transactions (CSV import, custom integrations, off-platform
 * bank feeds). Wraps the shared `ingestTransactions` library used by the
 * bank-file importer and the PSD2 sync.
 *
 * The pipeline runs:
 *   1. Dedup by external_id + content-based (date+amount).
 *   2. Insert into transactions.
 *   3. Auto-match invoices (OCR/reference + amount+customer fallback).
 *   4. Mapping-rule evaluation for auto-categorization.
 *   5. High-confidence auto-JE creation.
 *
 * Dry-run skips all writes and returns the dedup decision per item so
 * callers can preview what would be ingested before committing. The preview
 * and the commit run the SAME decision function over the same rows
 * (lib/transactions/dedup-preview.ts), and the commit reports every skipped
 * row with its reason and the stored row it matched: a row that is not
 * imported is always named in the response, never only counted.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { previewIngestDedup } from '@/lib/transactions/dedup-preview'
import { isImportedTransaction } from '@/lib/transactions/origin'
import type { IngestSkipReason, RawTransaction } from '@/types'

const RawTx = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be ISO yyyy-MM-dd'),
  description: z.string().min(1).max(500),
  amount: z.number().refine((n) => n !== 0, 'amount must be non-zero'),
  currency: z.string().min(1).max(8),
  external_id: z.string().min(1).max(200),
  mcc_code: z.number().int().nullable().optional(),
  merchant_name: z.string().max(200).nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  import_source: z.string().min(1).max(50).optional(),
})

const IngestRequest = z
  .object({
    transactions: z.array(RawTx).min(1).max(500),
    skip_auto_categorization: z.boolean().optional(),
    settlement_account: z
      .string()
      .regex(/^\d{4}$/, 'settlement_account must be a 4-digit account number')
      .optional(),
    raw_insert_only: z.boolean().optional(),
    stable_external_ids: z
      .boolean()
      .optional()
      .describe(
        'Set true only when every external_id is the bank\'s own per-booking reference: the same booking always arrives under the same id, and a different id is a different booking. A stored transaction from the same import_source under another id is then never treated as a copy of an incoming row. Requires the same import_source on every row.',
      ),
  })
  .superRefine((body, ctx) => {
    if (!body.stable_external_ids) return
    // The feed label is the id namespace: without one, "the same feed" cannot
    // be told from rows typed in by hand, and the statement would silently do
    // nothing. Refuse instead of pretending.
    const feed = body.transactions[0]?.import_source
    const labelled =
      feed !== undefined &&
      isImportedTransaction({ import_source: feed }) &&
      body.transactions.every((tx) => tx.import_source === feed)
    if (!labelled) {
      ctx.addIssue({
        code: 'custom',
        path: ['stable_external_ids'],
        message:
          'stable_external_ids requires every transaction to carry the same import_source (your feed label, not "manual" or "mcp")',
      })
    }
  })

const SkipReason = z.enum(['external_id_match', 'content_match_booked', 'content_match_unbooked'])

const DuplicatesByReason = z.object({
  external_id_match: z.number().int(),
  content_match_booked: z.number().int(),
  content_match_unbooked: z.number().int(),
})

const IngestResponse = z.object({
  imported: z.number().int(),
  duplicates: z.number().int().describe('Rows skipped as already stored: the length of `skipped`.'),
  duplicates_by_reason: DuplicatesByReason.describe(
    '`duplicates` split by reason. A content match is a judgement call; an external_id match is an exact key.',
  ),
  skipped: z
    .array(
      z.object({
        external_id: z.string().describe('The external_id you sent for the row.'),
        reason: SkipReason,
        matched_external_id: z
          .string()
          .nullable()
          .describe('external_id of the stored transaction that stands for the row.'),
        matched_transaction_id: z.string().uuid().nullable().describe('id of that stored transaction.'),
      }),
    )
    .describe('Every row that was NOT imported because it is judged already stored, in request order.'),
  reconciled: z.number().int(),
  auto_categorized: z.number().int(),
  auto_matched_invoices: z.number().int(),
  errors: z.number().int(),
  transaction_ids: z.array(z.string().uuid()),
})

const NO_DUPLICATES: Record<IngestSkipReason, number> = {
  external_id_match: 0,
  content_match_booked: 0,
  content_match_unbooked: 0,
}

registerEndpoint({
  operation: 'transactions.ingest',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/ingest',
  summary: 'Bulk-ingest transactions (up to 500 per call).',
  description:
    'Runs the same ingest pipeline as the dashboard CSV importer and the PSD2 bank sync: dedup, insert, invoice match, mapping-rule auto-categorize, auto-JE for high-confidence matches. Idempotent over the whole batch via Idempotency-Key. Dry-runnable.',
  useWhen:
    'You\'re importing transactions from a CSV, a custom bank feed, or an external accounting system. Each item must have a stable external_id: this is the primary dedup key.',
  doNotUseFor:
    'Single ad-hoc transactions (use the dashboard). Documents/receipts (use the documents endpoint). Manually-created journal entries (Phase 4).',
  pitfalls: [
    'external_id is the primary dedup key: make it stable for the same physical transaction across reruns.',
    'Content-based dedup runs in addition: a row matching a stored transaction (booked, or unbooked from an import feed) by date, amount, currency, account AND description (prefix-containment, to survive PSD2 title enrichment) is skipped even if external_id differs. Each stored row absorbs at most one incoming row per call.',
    'Identical real movements (a bank that books several identical fees on one day) each need their own external_id. Sent in one call they are all imported; sent in a later call, alone, a new one is absorbed by a stored twin unless you set stable_external_ids=true. Set it only when the id is the bank\'s own per-booking reference (never for line numbers or content hashes) and keep one import_source per id scheme: if the scheme changes, change the label.',
    'A skipped row is never only counted: the response lists it in `skipped` with its reason (external_id_match, content_match_booked, content_match_unbooked) and the stored transaction it matched. Treat a content_match on a row you know is new as a missing transaction and alert on it.',
    'raw_insert_only=true skips ALL post-insert pipeline steps (matching, categorization). Use for viewer-only imports.',
    'Max 500 items per call. For larger imports, split into pages of 500.',
    'Dry-run runs the same dedup decision as the commit, row by row, with the same reasons. It differs only if the stored transactions change in between.',
  ],
  example: {
    request: {
      transactions: [
        {
          date: '2026-05-12',
          description: 'ICA MAXI',
          amount: -349.5,
          currency: 'SEK',
          external_id: 'csv-line-42',
          merchant_name: 'ICA MAXI',
        },
      ],
    },
    response: {
      data: {
        imported: 1,
        duplicates: 0,
        duplicates_by_reason: { external_id_match: 0, content_match_booked: 0, content_match_unbooked: 0 },
        skipped: [],
        reconciled: 0,
        auto_categorized: 0,
        auto_matched_invoices: 0,
        errors: 0,
        transaction_ids: ['5b1f6c1e-8a3d-4f0e-9a51-2f6d0c9b7e10'],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: IngestRequest },
  response: { success: dataEnvelope(IngestResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'transactions.ingest',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = IngestRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (ctx.dryRun) {
      // The dry-run asks the pipeline's own decision function what the commit
      // will do, with the options the commit will get. It used to be a
      // lookalike that knew only booked rows, so it answered would_import for
      // a row the commit then skipped against an unbooked twin: a real
      // movement missing from the books with nothing to show for it, where
      // BFL 5 kap wants every affärshändelse bokförd (see the
      // swedish-accounting-compliance skill, "Löpande bokföring").
      const rows = await previewIngestDedup(ctx.supabase, ctx.companyId!, body.transactions, {
        settlementAccount: body.settlement_account,
        stableExternalIds: body.stable_external_ids,
      })
      const wouldSkipByReason = { ...NO_DUPLICATES }
      const previewRows = body.transactions.map((tx, index) => {
        const row = rows[index]
        if (row.skip_reason) wouldSkipByReason[row.skip_reason]++
        return {
          external_id: tx.external_id,
          date: tx.date,
          amount: tx.amount,
          currency: tx.currency,
          would_skip: row.would_skip,
          skip_reason: row.skip_reason,
          matched_external_id: row.matched_external_id,
          matched_transaction_id: row.matched_transaction_id,
        }
      })
      const wouldSkip = previewRows.filter((r) => r.would_skip).length

      return dryRunPreview(
        {
          would_import: previewRows.length - wouldSkip,
          would_skip_duplicates: wouldSkip,
          would_skip_by_reason: wouldSkipByReason,
          items: previewRows,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    let result
    try {
      result = await ingestTransactions(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        body.transactions as RawTransaction[],
        {
          skipAutoCategorization: body.skip_auto_categorization,
          settlementAccount: body.settlement_account,
          rawInsertOnly: body.raw_insert_only,
          stableExternalIds: body.stable_external_ids,
        },
      )
    } catch (err) {
      ctx.log.error('transactions.ingest: pipeline failed', err as Error)
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    return ok(
      {
        imported: result.imported,
        duplicates: result.duplicates,
        duplicates_by_reason: result.duplicates_by_reason ?? NO_DUPLICATES,
        skipped: result.skipped ?? [],
        reconciled: result.reconciled,
        auto_categorized: result.auto_categorized,
        auto_matched_invoices: result.auto_matched_invoices,
        errors: result.errors,
        transaction_ids: result.transaction_ids,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
