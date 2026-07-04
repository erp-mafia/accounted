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
 * callers can preview what would be ingested before committing.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { contentBucketKey, descriptionsBridge, normalizeImportedDescription } from '@/lib/transactions/external-id'
import type { RawTransaction } from '@/types'

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

const IngestRequest = z.object({
  transactions: z.array(RawTx).min(1).max(500),
  skip_auto_categorization: z.boolean().optional(),
  settlement_account: z
    .string()
    .regex(/^\d{4}$/, 'settlement_account must be a 4-digit account number')
    .optional(),
  raw_insert_only: z.boolean().optional(),
})

const IngestResponse = z.object({
  imported: z.number().int(),
  duplicates: z.number().int(),
  reconciled: z.number().int(),
  auto_categorized: z.number().int(),
  auto_matched_invoices: z.number().int(),
  errors: z.number().int(),
  transaction_ids: z.array(z.string().uuid()),
})

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
    'Content-based dedup runs in addition: a row matching an already-booked transaction by date, amount AND description (prefix-containment, to survive PSD2 title enrichment) is skipped even if external_id differs.',
    'raw_insert_only=true skips ALL post-insert pipeline steps (matching, categorization). Use for viewer-only imports.',
    'Max 500 items per call. For larger imports, split into pages of 500.',
    'Dry-run previews external_id + content dedup against BOOKED rows only; the live pipeline also dedups against unbooked bank-synced rows, so preview skips are a lower bound on the live skip count.',
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
      data: { imported: 1, skipped_duplicates: 0 },
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
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = IngestRequest.safeParse(rawBody)
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

    if (ctx.dryRun) {
      // Dry-run runs BOTH dedup checks the live pipeline runs:
      //   1. external_id match against any existing transaction
      //   2. content match (date + amount) against already-booked rows
      // The live pipeline narrows (2) to date range + booked-only, so we
      // mirror that here. Without this, an integrator who relies on dry-run
      // to confirm uniqueness can ingest a duplicate affärshändelse:
      // BFL 5 kap requires löpande bokföring to reflect actual transactions
      // and forbids double-bookings.
      const externalIds = body.transactions.map((t) => t.external_id)
      const dates = [...body.transactions.map((t) => t.date)].sort()
      const dateFrom = dates[0]
      const dateTo = dates[dates.length - 1]

      const { data: existingByExtId } = await ctx.supabase
        .from('transactions')
        .select('external_id')
        .eq('company_id', ctx.companyId!)
        .in('external_id', externalIds)
      const knownExtIds = new Set(
        (existingByExtId ?? []).map((r) => (r as { external_id: string }).external_id),
      )

      const { data: bookedInRange } = await ctx.supabase
        .from('transactions')
        .select('date, amount, original_description, description')
        .eq('company_id', ctx.companyId!)
        .not('journal_entry_id', 'is', null)
        .gte('date', dateFrom)
        .lte('date', dateTo)
      // Mirror the live pipeline's content-dedup bridge (lib/transactions/ingest.ts):
      // bucket booked rows by (date, öre) and match by description prefix-containment
      // (keyed off the immutable original_description), consumed with the SAME
      // longest-match + counting semantics: so a batch of N copies against M booked
      // twins previews M skips and N−M imports, not N. Scope note: like the live
      // pipeline's booked map this previews ONLY booked rows; the unbooked
      // enable_banking overlap check is not modelled here.
      const bookedBuckets = new Map<string, string[]>()
      for (const r of bookedInRange ?? []) {
        const row = r as { date: string; amount: number | string; original_description: string | null; description: string | null }
        const key = contentBucketKey(row.date, row.amount)
        const desc = normalizeImportedDescription(row.original_description ?? row.description).toLowerCase().trim()
        const bucket = bookedBuckets.get(key)
        if (bucket) bucket.push(desc)
        else bookedBuckets.set(key, [desc])
      }
      // Consume the longest bridging stored description (counting semantics): the
      // same logic as ingest.ts consumeBridgingTwin, on this preview's mutable copy.
      const consumeBookedTwin = (date: string, amount: number, desc: string): boolean => {
        const descs = bookedBuckets.get(contentBucketKey(date, amount))
        if (!descs || descs.length === 0) return false
        let bestIdx = -1
        let bestLen = -1
        for (let i = 0; i < descs.length; i++) {
          if (descriptionsBridge(desc, descs[i]) && descs[i].length > bestLen) {
            bestIdx = i
            bestLen = descs[i].length
          }
        }
        if (bestIdx === -1) return false
        descs.splice(bestIdx, 1)
        return true
      }

      const previewRows = body.transactions.map((tx) => {
        const extIdHit = knownExtIds.has(tx.external_id)
        // external_id precedence mirrors the live pipeline: a row caught by
        // external_id must NOT consume a booked twin (so it stays available for a
        // genuine content-only duplicate later in the batch).
        const contentHit =
          !extIdHit && consumeBookedTwin(tx.date, tx.amount, normalizeImportedDescription(tx.description))
        const wouldSkip = extIdHit || contentHit
        const reason = extIdHit
          ? 'external_id_match'
          : contentHit
            ? 'content_match_booked'
            : null
        return {
          external_id: tx.external_id,
          date: tx.date,
          amount: tx.amount,
          currency: tx.currency,
          would_skip: wouldSkip,
          skip_reason: reason,
        }
      })
      const wouldImport = previewRows.filter((r) => !r.would_skip).length
      const wouldSkip = previewRows.filter((r) => r.would_skip).length

      return dryRunPreview(
        {
          would_import: wouldImport,
          would_skip_duplicates: wouldSkip,
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
