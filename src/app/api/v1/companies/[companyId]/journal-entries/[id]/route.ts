/**
 * GET /api/v1/companies/{companyId}/journal-entries/{id}
 *
 * Returns the full verifikation including lines, source links
 * (reverses_id, reversed_by_id, correction_of_id), and dimensions.
 *
 * PATCH edits a DRAFT in place (operation journal-entries.update-draft,
 * contract and rules in src/lib/operations/journal-entries.ts).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { cancelDraftJournalEntry } from '@/lib/core/bookkeeping/journal-entry-edits'
import { v1OperationHandler, v1OutcomeResponse } from '@/lib/operations/v1'
import { journalEntriesUpdateDraft } from '@/lib/operations/journal-entries'

// `dimensions` is the line's whole SIE tag bag; cost_center/project only
// mirror keys '1'/'6', so a read without the bag hid dims 2, 7-9 and 20+.
const JE_LINE_COLUMNS =
  'id, account_number, debit_amount, credit_amount, line_description, currency, amount_in_currency, exchange_rate, tax_code, dimensions, cost_center, project, sort_order'
const JE_DETAIL_COLUMNS =
  'id, fiscal_period_id, voucher_series, voucher_number, entry_date, description, status, source_type, source_id, notes, reverses_id, reversed_by_id, correction_of_id, created_at, updated_at'

const JournalEntryLine = z.object({
  id: z.string().uuid(),
  account_number: z.string(),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().nullable(),
  currency: z.string().nullable(),
  amount_in_currency: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  tax_code: z.string().nullable(),
  dimensions: z
    .record(z.string(), z.string())
    .describe('SIE dimension tags, {"<dim_no>": "<code>"}: "1" kostnadsställe, "6" projekt, 20+ custom. {} when untagged.'),
  cost_center: z.string().nullable().describe('Mirror of dimensions["1"].'),
  project: z.string().nullable().describe('Mirror of dimensions["6"].'),
  sort_order: z.number().int(),
})

const JournalEntryDetail = z.object({
  id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  entry_date: z.string(),
  description: z.string(),
  status: z.enum(['draft', 'posted', 'cancelled']),
  source_type: z.string(),
  source_id: z.string().nullable(),
  notes: z.string().nullable(),
  reverses_id: z.string().uuid().nullable(),
  reversed_by_id: z.string().uuid().nullable(),
  correction_of_id: z.string().uuid().nullable(),
  lines: z.array(JournalEntryLine),
  created_at: z.string(),
  updated_at: z.string(),
})

registerEndpoint({
  operation: 'journal-entries.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/journal-entries/:id',
  summary: 'Retrieve a single verifikation by id.',
  description:
    'Returns the full journal entry including all lines, dimensions, and the storno chain (reverses_id, reversed_by_id, correction_of_id).',
  useWhen:
    'You need the full verifikation for audit / reconciliation, or to display the line-by-line breakdown.',
  doNotUseFor:
    'Listing entries (use the list endpoint with filters).',
  pitfalls: [
    'Cancelled drafts are returned (no filter on status here); inspect status before assuming the entry is posted.',
    'Lines are sorted by sort_order; the order matters for display but not for accounting (the sum across lines is the meaningful quantity).',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        voucher_series: 'A',
        voucher_number: 142,
        entry_date: '2026-05-12',
        status: 'posted',
        lines: [
          { account_number: '6570', debit_amount: 50, credit_amount: 0, dimensions: { '6': 'P001', '20': 'SYD' }, cost_center: null, project: 'P001', sort_order: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 50, dimensions: {}, cost_center: null, project: null, sort_order: 1 },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(JournalEntryDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('journal_entries')
      .select(`${JE_DETAIL_COLUMNS}, lines:journal_entry_lines(${JE_LINE_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .eq('id', idParse.data)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) {
      return v1ErrorResponseFromCode('JOURNAL_ENTRY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// DELETE: cancel an uncommitted DRAFT verifikation
// ──────────────────────────────────────────────────────────────────

const JournalEntryCancelled = JournalEntryDetail.omit({ lines: true }).extend({
  status: z.literal('cancelled'),
})

registerEndpoint({
  operation: 'journal-entries.cancel',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/journal-entries/:id',
  summary: 'Cancel an uncommitted draft verifikation.',
  description:
    'Flips a draft journal entry to status=cancelled through the engine. A draft holds no voucher_number, so cancelling one leaves NO gap in the löpande nummerordning BFL 5 kap 7 § requires, and therefore needs no documented gap explanation. The header row survives as cancelled evidence rather than being deleted; its lines survive with it, and both stay archived for the 7 years BFL 7 kap requires. Posted and reversed entries are refused with 409 CANNOT_CANCEL_NON_DRAFT: a posted verifikation may only be undone through a rättelse that keeps the original visible and records who corrected it and when (BFL 5 kap 5 §), which is what /reverse (storno) does. Idempotent: cancelling an already-cancelled draft returns 200 with the same entry.',
  useWhen:
    'A draft created via POST /journal-entries will never be committed: a duplicate, an abandoned import, a draft the agent decided against. Stranded drafts block the year-end close (DRAFT_ENTRIES blocker), so clear them here instead of leaving them for a human in the app.',
  doNotUseFor:
    'Undoing a posted verifikat (use POST /{id}/reverse for storno, or /{id}/correct to replace it). Editing a draft: there is no v1 draft-edit endpoint; cancel and create a new draft.',
  pitfalls: [
    'Only status=draft can be cancelled. Anything posted returns 409 CANNOT_CANCEL_NON_DRAFT with details.currentStatus; storno it instead.',
    'No voucher number is released or burned: drafts never held one, so the unbroken series BFL 5 kap 7 § requires is untouched and there is no gap to document. The cancelled header stays visible via GET /{id} and via the list endpoint with status=cancelled.',
    'A draft in a locked or closed period, or behind the company lock date, returns PERIOD_LOCKED: unlock the period first rather than retrying.',
    'A draft that holds documents returns 409 DRAFT_HAS_DOCUMENTS with details.documents: once cancelled its documents could never be linked to another verifikat, so book the draft instead.',
    'Idempotency-Key is optional here (unlike the other journal-entries writes) because the call is idempotent by construction: a second DELETE returns the same cancelled entry.',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        voucher_series: 'A',
        voucher_number: 0,
        entry_date: '2026-05-12',
        status: 'cancelled',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  // Low: nothing leaves the ledger. A draft is not bokförd, holds no voucher
  // number, and the row itself survives as cancelled.
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  response: { success: dataEnvelope(JournalEntryCancelled) },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'journal-entries.cancel',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Journal entry id must be a UUID.' },
      })
    }
    // The rules (draft only, lock pre-check, idempotent on cancelled) live in
    // cancelDraftJournalEntry, shared with the staged MCP tool
    // gnubok_cancel_draft_entry (operation journal-entries.cancel-draft), so
    // the two doors cannot answer differently.
    const outcome = await cancelDraftJournalEntry(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      idParse.data,
      { dryRun: ctx.dryRun },
    )
    return v1OutcomeResponse(outcome, ctx)
  },
)

export const PATCH = v1OperationHandler(journalEntriesUpdateDraft)
