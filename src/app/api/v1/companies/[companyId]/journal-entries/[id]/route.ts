/**
 * GET /api/v1/companies/{companyId}/journal-entries/{id}
 *
 * Returns the full verifikation including lines, source links
 * (reverses_id, reversed_by_id, correction_of_id), dimensions, the
 * decision receipts recorded for it (src/lib/suggestion-log/receipts.ts),
 * and what is linked to it with each link's recorded basis
 * (src/lib/links/voucher-links.ts).
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
import { DecisionReceiptSchema, MAX_RECEIPTS_PER_SUBJECT, getDecisionReceipts } from '@/lib/suggestion-log/receipts'
import { MAX_VOUCHER_LINKS_PER_KIND, VoucherLinkSchema, getVoucherLinks } from '@/lib/links/voucher-links'

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

const JournalEntryRead = JournalEntryDetail.extend({
  decision_receipts: z
    .array(DecisionReceiptSchema)
    .nullable()
    .describe(
      'How the verifikation was decided, newest first: one receipt per recorded decision (bank line, underlag, or an approved staged operation) that booked it. Empty for a voucher no recorded decision produced (hand-made, imported, or booked before decisions were logged). Null when the receipts could not be read this time: unknown, not "none"; retry the read.',
    ),
  links: z
    .array(VoucherLinkSchema)
    .nullable()
    .describe(
      'What is linked to the verifikation (bank rows, underlag, invoice and supplier payments, ledger settlements), each with why: basis and evidence as recorded when the link was made, null on links made before 2026-10-16. Null when the links could not be read this time; retry the read.',
    ),
})

registerEndpoint({
  operation: 'journal-entries.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/journal-entries/:id',
  summary: 'Retrieve a single verifikation by id.',
  description:
    'Returns the full journal entry including all lines, dimensions, the storno chain (reverses_id, reversed_by_id, correction_of_id), decision_receipts: who decided the booking (person, API key or agent), the suggestions on offer, which one was booked, its recorded confidence, and the rules, approval policy, inputs hash and guards it was decided under, and links: the bank rows, underlag and payments linked to it, each with the basis it was linked on.',
  useWhen:
    'You need the full verifikation for audit / reconciliation, or to display the line-by-line breakdown.',
  doNotUseFor:
    'Listing entries (use the list endpoint with filters).',
  pitfalls: [
    'Cancelled drafts are returned (no filter on status here); inspect status before assuming the entry is posted.',
    'Lines are sorted by sort_order; the order matters for display but not for accounting (the sum across lines is the meaningful quantity).',
    `decision_receipts holds at most ${MAX_RECEIPTS_PER_SUBJECT} receipts: a samlingsverifikat carries one per bank line. It is null (unknown) when the receipts could not be read; an empty list means none were recorded. rule_version, policy_version, input_hash, checks and confidence_band are recorded at decision time from 2026-10-16 and null on earlier decisions; they are never derived when read.`,
    "confidence.basis 'model_reported' is the reading model's own score for an underlag, not evidence; only 'backing' comes from deterministic evidence.",
    'checks lists only the guards that ran: an absent guard did not apply, it did not pass. A warn result is an override (force, allow_duplicate, confirm_no_match) or a guard that could not run; its detail says which.',
    `links holds at most ${MAX_VOUCHER_LINKS_PER_KIND} links of each kind. A link basis null means not recorded (links before 2026-10-16, or a writer that does not record one yet), never a guess. client_asserted means an API or MCP client named the pair and nobody approved it in Accounted; agent_proposed_user_approved means a person approved what an agent staged.`,
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
        decision_receipts: [
          {
            receipt_id: '5c1e…',
            subject_kind: 'bank_line',
            decided_at: '2026-05-12T09:14:00Z',
            outcome: 'accepted',
            decided_by: { actor_type: 'api_key', user_id: '3f2a…', label: 'Integration', commit_method: 'api_key' },
            proposed_by: null,
            candidates: [
              { source: 'rule', source_id: 'rule:9d1f…', rank: 0, accounts: ['6570'], vat_treatment: 'exempt', confidence: 0.92, model: null, prompt_sha256: null, matches_final: true, contested: false, agreement: null, from_candidate: null, reasoning_sha256: null },
            ],
            chosen: { source: 'rule', source_id: 'rule:9d1f…', rank: 0, accounts: ['6570'], vat_treatment: 'exempt', confidence: 0.92, model: null, prompt_sha256: null, matches_final: true, contested: false, agreement: null, from_candidate: null, reasoning_sha256: null },
            booked: { journal_entry_id: '0e9c…', voucher: 'A142', entry_status: 'posted', account: '6570', vat_treatment: 'exempt', supplier_invoice_id: null, changed_fields: [] },
            evidence: { transaction_id: '7b3a…', inbox_item_id: null, document_ids: [] },
            confidence: { value: 0.92, basis: 'backing' },
            rule_version: 'bank-proposals.1+a38016f12abc',
            policy_version: 'direct-booking.1;assistant_sure=0.8;counterpart_seen=3;calibrator=none',
            input_hash: '4f1c…',
            checks: [
              { id: 'already_booked', result: 'pass', detail: null },
              { id: 'duplicate', result: 'pass', detail: null },
              { id: 'counter_legs', result: 'pass', detail: null },
              { id: 'chart', result: 'pass', detail: null },
              { id: 'period_lock', result: 'pass', detail: null },
            ],
            confidence_band: 'direct',
          },
        ],
        links: [
          { kind: 'bank_transaction', transaction_id: '7b3a…', via: 'pointer', document_id: null, invoice_id: null, invoice_payment_id: null, supplier_invoice_id: null, supplier_invoice_payment_id: null, settlement_id: null, basis: 'user_created', evidence: null },
          { kind: 'document', transaction_id: null, via: null, document_id: '9d2e…', invoice_id: null, invoice_payment_id: null, supplier_invoice_id: null, supplier_invoice_payment_id: null, settlement_id: null, basis: 'system_derived', evidence: { rule_id: 'bank_row_document_pin' } },
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
  response: { success: dataEnvelope(JournalEntryRead) },
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
    // Additive: read after the entry, so an unknown id never costs the lookup.
    // A failed lookup must not take the verifikation read down with it, and
    // must not pass for "no decision" either: it answers null (unknown).
    let receipts: Awaited<ReturnType<typeof getDecisionReceipts>> | null
    try {
      receipts = await getDecisionReceipts(ctx.supabase, ctx.companyId!, { journalEntryId: idParse.data })
    } catch (err) {
      ctx.log.error('journal-entries.get decision receipts failed', err as Error)
      receipts = null
    }
    // Same contract for the links: a failed read answers null (unknown).
    let links: Awaited<ReturnType<typeof getVoucherLinks>> | null
    try {
      links = await getVoucherLinks(ctx.supabase, ctx.companyId!, idParse.data)
    } catch (err) {
      ctx.log.error('journal-entries.get links failed', err as Error)
      links = null
    }
    return ok({ ...data, decision_receipts: receipts, links }, { requestId: ctx.requestId })
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
    'A draft that holds documents returns 409 DRAFT_HAS_DOCUMENTS with details.documents: once cancelled its documents could never be linked to another verifikat. The user deletes the draft in Accounted instead (Bokföring › the verifikat › Fler alternativ › Radera utkast), which keeps the documents so they can be linked to another verifikat, or books the draft.',
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
