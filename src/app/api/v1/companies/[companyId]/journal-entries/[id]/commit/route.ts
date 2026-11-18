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
 * the would-be voucher_number read from voucher_sequences, without advancing
 * the sequence).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { peekNextVoucherNumber } from '@/lib/bookkeeping/engine'
import { postingPort } from '@/lib/posting/port'
import { entryDebitTotal } from '@/lib/bookkeeping/unattended-ceiling'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { AcknowledgedWarningsSchema, DASHBOARD_VOUCHER_SOURCE_TYPES } from '@/lib/api/schemas'
import { recordVoucherWarningsAcknowledged, runVoucherWarningsGuard } from '@/lib/bookkeeping/voucher-warnings-guard'
import { linkOpenBankRowsToVoucher } from '@/lib/reconciliation/voucher-bank-link'

const JE_RESPONSE_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, created_at, updated_at'

// Optional: the warnings the caller confirmed after a VOUCHER_NEEDS_CONFIRMATION answer.
const CommitRequest = z.object({
  acknowledged_warnings: AcknowledgedWarningsSchema,
})

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
    'You created a draft via POST /journal-entries and now want to post it to the books. After commit the entry can only be changed through a rättelse that keeps the original visible and records who corrected it and when (BFL 5 kap 5 §): corrections require /reverse or /correct.',
  doNotUseFor:
    'Re-committing an already-posted entry (returns 409). Committing across companies: the URL companyId must match the draft\'s company.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Posted entries cannot be edited. Plan the lines carefully or call /correct after commit if you need to change them.',
    'Voucher numbers are sequential within (fiscal_period_id, voucher_series). A commit failure (e.g. period locked between draft creation and commit) does not advance the sequence.',
    'If the key has an unattended commit limit, an entry above it returns 403 UNATTENDED_COMMIT_LIMIT_EXCEEDED and stays a draft for a human to commit. Do not split it into smaller entries: one affärshändelse is one verifikat (BFL 5 kap. 6 §).',
    'A manual draft that needs a person\'s confirmation (VAT above 25 % of what it applies to, VAT on the wrong kind of account, one-sided reverse charge, a revenue account debited in a purchase, a duplicate of a posted verifikat or of booked bank money, or lines that change a momsdeklaration already filed) returns 409 VOUCHER_NEEDS_CONFIRMATION with error.details.warnings and stays a draft. Show the warnings to a person; commit again with acknowledged_warnings only if they confirm.',
    'A draft with source_type bank_transaction whose bank_booking_context does not name its source_id returns 409 BANK_BOOKING_CONTEXT_REQUIRED and stays a draft: book the transaction itself instead, or create the draft again with a bank_booking_context entry for it.',
  ],
  example: {
    request: { acknowledged_warnings: ['INPUT_VAT_ABOVE_RATE'] },
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
  request: { body: CommitRequest },
  response: { success: dataEnvelope(JournalEntryCommitted) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.commit',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }
    const entryId = idParse.data

    // The body is optional: its one field is the confirmed warnings.
    let acknowledged: string[] | undefined
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      // Not swallowed: a body that is not JSON is the caller's bug, answered as 400.
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    if (rawBody) {
      const parsed = CommitRequest.safeParse(rawBody)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)
      acknowledged = parsed.data.acknowledged_warnings
    }

    // Pre-flight: confirm the draft exists, status='draft', and is in this company.
    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('journal_entries')
      .select('id, status, fiscal_period_id, voucher_series, entry_date, description, source_type, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
      .eq('company_id', ctx.companyId!)
      .eq('id', entryId)
      .maybeSingle()

    if (fetchErr) return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    if (!existing) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const typed = existing as {
      id: string
      status: string
      fiscal_period_id: string
      voucher_series: string
      entry_date: string
      description: string | null
      source_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }> | null
    }
    if (typed.status !== 'draft') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'status', message: 'Only draft entries can be committed.', current_status: typed.status },
      })
    }

    // Booking-time warnings on a typed draft, before the dry run so a dry run
    // answers what the commit would (lib/bookkeeping/voucher-warnings-guard.ts).
    const voucherGuard = (DASHBOARD_VOUCHER_SOURCE_TYPES as readonly string[]).includes(typed.source_type)
      ? await runVoucherWarningsGuard(
          ctx.supabase,
          ctx.companyId!,
          { entry_date: typed.entry_date, description: typed.description ?? '', lines: typed.lines ?? [] },
          ctx.log,
          { acknowledged, excludeJournalEntryId: entryId },
        )
      : null
    if (voucherGuard && !voucherGuard.ok) {
      return v1ErrorResponseFromCode(voucherGuard.code, ctx.log, { requestId: ctx.requestId, details: voucherGuard.details })
    }

    // ── Approval-authority ceiling.
    //
    //    commitEntry refuses a draft above the key's ceiling whatever door
    //    commits it (lib/bookkeeping/unattended-ceiling.ts). Asked here as
    //    well, after the draft-exists and status checks, so the refusal names
    //    the draft and comes before the dry-run branch: a dry run that reports
    //    "would post voucher 143" for a commit the key is not allowed to make
    //    is a lie the agent will act on. A refusal leaves the draft a draft:
    //    nothing is destroyed, the voucher sequence does not move (BFL 5 kap.
    //    7 §), and the human commits the same draft from the app.
    //
    //    Known and accepted: the line sum is read before the RPC commits, so a
    //    concurrent write to the draft's lines between the two can post more
    //    than the ceiling. Closing that window means enforcing inside
    //    commit_journal_entry, where a RAISE is swallowed into a retryable 500
    //    and, on the MCP path, destroys the staged operation. The trade is
    //    deliberate and consistent with what this control claims to be: a
    //    blast-radius cap on a looping or prompt-injected agent, NOT a security
    //    boundary. A per-entry ceiling is already defeated by splitting one
    //    entry into several, which needs no race at all. The primitive that
    //    actually bounds exposure is a cumulative rolling-window limit, tracked
    //    separately.
    if (ctx.unattendedCommitLimit !== null) {
      const attempted = await entryDebitTotal(ctx.supabase, entryId)
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
      // Report the next voucher number WITHOUT advancing the sequence: a dry
      // run that took a number would leave a gap in the löpnummer series. The
      // number is a projection; a concurrent commit can take it between dry
      // run and commit, the same caveat the dry-run.ts substrate documents.
      const projectedNumber = await peekNextVoucherNumber(
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
      // Posting port (step 2i): the draft's event was linked when it was made.
      const committed = await postingPort.commitJournalEntry({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        entryId,
      })
      if (voucherGuard?.ok) {
        await recordVoucherWarningsAcknowledged({
          companyId: ctx.companyId!,
          userId: ctx.userId,
          journalEntryId: entryId,
          warnings: voucherGuard.acknowledged,
          door: 'v1_commit',
          log: ctx.log,
        })
        // A posted typed verifikat meets the open bank row it books
        // (lib/reconciliation/voucher-bank-link.ts).
        await linkOpenBankRowsToVoucher(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          { journalEntryId: entryId, entryDate: typed.entry_date, lines: typed.lines ?? [] },
          ctx.log,
        )
      }
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
