/**
 * POST /api/v1/companies/{companyId}/journal-entries/{id}/commit
 *
 * Commits a draft journal entry: assigns the next voucher_number from the
 * series atomically via the `commit_journal_entry` RPC and flips status to
 * 'posted'. The RPC is a single Postgres transaction: if the balance
 * trigger or any other constraint rejects, the sequence does NOT advance
 * (no löpnummer gap per BFL 5 kap 7 §).
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable (the dry-run reports
 * the would-be voucher_number from `get_next_voucher_number` without
 * advancing the sequence).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { commitEntry, getNextVoucherNumber } from '@/lib/bookkeeping/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'

const JE_RESPONSE_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, created_at, updated_at'

const JournalEntryCommitted = z.object({
  id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  status: z.literal('posted'),
  entry_date: z.string(),
})

registerEndpoint({
  operation: 'journal-entries.commit',
  method: 'POST',
  path: '/api/v1/companies/:companyId/journal-entries/:id/commit',
  summary: 'Commit a draft journal entry.',
  description:
    'Atomically advances the voucher series and flips the draft to posted. The voucher_number is the smallest integer not yet used in (fiscal_period_id, voucher_series); a failed commit does NOT burn the number.',
  useWhen:
    'You created a draft via POST /journal-entries and now want to post it to the books. After commit the entry is immutable per BFL 5 kap 2 §; corrections require /reverse or /correct.',
  doNotUseFor:
    'Re-committing an already-posted entry (returns 409). Committing across companies: the URL companyId must match the draft\'s company.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Posted entries cannot be edited. Plan the lines carefully or call /correct after commit if you need to change them.',
    'Voucher numbers are sequential within (fiscal_period_id, voucher_series). A commit failure (e.g. period locked between draft creation and commit) does not advance the sequence.',
    'If the key has an unattended commit limit, an entry above it returns 403 UNATTENDED_COMMIT_LIMIT_EXCEEDED and stays a draft for a human to commit. Do not split it into smaller entries: one affärshändelse is one verifikat (BFL 5 kap. 6 §).',
  ],
  example: {
    response: {
      data: { id: '0e9c…', voucher_series: 'A', voucher_number: 143, status: 'posted', entry_date: '2026-05-12' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: dataEnvelope(JournalEntryCommitted) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.commit',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }
    const entryId = idParse.data

    // Pre-flight: confirm the draft exists, status='draft', and is in this company.
    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, fiscal_period_id, voucher_series, entry_date')
      .eq('company_id', ctx.companyId!)
      .eq('id', entryId)
      .maybeSingle()

    if (fetchErr) return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    if (!existing) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const typed = existing as { id: string; status: string; fiscal_period_id: string; voucher_series: string; entry_date: string }
    if (typed.status !== 'draft') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'status', message: 'Only draft entries can be committed.', current_status: typed.status },
      })
    }

    // ── Approval-authority ceiling.
    //
    //    The second of the two places an API key posts money (the first is
    //    commitPendingOperation, for MCP). Placed after the draft-exists and
    //    status checks and BEFORE commitEntry, so a refusal leaves the draft a
    //    draft: nothing is destroyed, and the voucher sequence does not move
    //    (BFL 5 kap. 7 §). The human commits the same draft from the app.
    //
    //    Runs before the dry-run branch on purpose. A dry run that reports
    //    "would post voucher 143" for a commit the key is not allowed to make
    //    is a lie the agent will act on.
    //
    //    Known and accepted: the line sum is read here and the entry is
    //    committed below, so a concurrent write to the draft's lines between
    //    the two can post more than the ceiling. Closing that window means
    //    enforcing inside commit_journal_entry, where a RAISE is swallowed
    //    into a retryable 500 and, on the MCP path, destroys the staged
    //    operation. The trade is deliberate and consistent with what this
    //    control claims to be: a blast-radius cap on a looping or
    //    prompt-injected agent, NOT a security boundary. A per-entry ceiling
    //    is already defeated by splitting one entry into several, which needs
    //    no race at all. The primitive that actually bounds exposure is a
    //    cumulative rolling-window limit, tracked separately.
    if (ctx.unattendedCommitLimit !== null) {
      const lines = await fetchAllRows<{ id: string; debit_amount: number | null }>(
        ({ from, to }) =>
          ctx.supabase
            .from('journal_entry_lines')
            .select('id, debit_amount')
            .eq('journal_entry_id', entryId)
            .order('id')
            .range(from, to),
        // The sum is money, so pagination correctness is not optional: a
        // regressed order would double-count a line and refuse a legitimate
        // commit. fetch-all.ts documents dedupeBy for exactly this case.
        { dedupeBy: (r) => r.id },
      )
      // Debits equal credits on any entry that can be committed (the balance
      // trigger enforces it), so the debit side alone is the entry's amount.
      const attempted = roundOre(lines.reduce((sum, l) => sum + (l.debit_amount ?? 0), 0))
      if (attempted > ctx.unattendedCommitLimit) {
        return v1ErrorResponseFromCode('UNATTENDED_COMMIT_LIMIT_EXCEEDED', ctx.log, {
          requestId: ctx.requestId,
          details: {
            attempted,
            limit: ctx.unattendedCommitLimit,
            journal_entry_id: entryId,
            entry_status: 'draft',
          },
        })
      }
    }

    if (ctx.dryRun) {
      // Report the next voucher number WITHOUT advancing the sequence. The
      // engine helper `getNextVoucherNumber` is a peek + increment; for a
      // true dry-run we'd want a non-advancing peek. Project convention: the
      // dry-run reports the PROJECTED number, with the caveat that a
      // concurrent commit could advance the sequence between dry-run and
      // commit: same caveat the dry-run.ts substrate documents.
      const projectedNumber = await getNextVoucherNumber(
        ctx.supabase,
        ctx.companyId!,
        typed.fiscal_period_id,
        typed.voucher_series ?? 'A',
      )
      return dryRunPreview(
        {
          id: typed.id,
          status: 'posted' as const,
          voucher_series: typed.voucher_series ?? 'A',
          voucher_number_assigned_on_commit: projectedNumber,
          entry_date: typed.entry_date,
          would_advance_sequence_by: 1,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const committed = await commitEntry(ctx.supabase, ctx.companyId!, ctx.userId, entryId)
      // Refetch the projection-only columns to keep the response shape tight.
      const { data } = await ctx.supabase
        .from('journal_entries')
        .select(JE_RESPONSE_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', entryId)
        .maybeSingle()
      return ok(data ?? committed, { requestId: ctx.requestId })
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('journal-entries.commit failed', err as Error, { entryId })
      return v1ErrorResponseFromCode('BOOKKEEPING_DATABASE_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'commit' },
      })
    }
  },
  { requireIdempotencyKey: true },
)
