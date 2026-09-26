/**
 * Journal-entry actions that were dashboard-only: the two sanctioned ways to
 * change a POSTED verifikat (inline rättelse through the audited RPCs, and a
 * date move through storno + re-post), editing a DRAFT, the internal note,
 * the "Inget underlag krävs" flag and the rättelse log.
 *
 * Nothing here writes a posted entry any other way (CLAUDE.md hard rule 1):
 * inline rättelse is correct_entry_metadata / correct_entry_lines_inline
 * (open, unlocked periods only, immutable who/when log), the date move is
 * recordateEntry (storno-service), and a draft edit is the engine's
 * updateDraftEntry, which refuses anything that is not a draft.
 *
 * Rules live in lib/core/bookkeeping/journal-entry-corrections.ts,
 * lib/core/bookkeeping/journal-entry-edits.ts and
 * lib/bookkeeping/no-doc-required.ts, shared with the dashboard routes under
 * app/api/bookkeeping/journal-entries/[id]/ and
 * app/api/bookkeeping/no-doc-required/batch.
 *
 * MCP: the three corrections and the batch flag stage (gnubok_correct_entry
 * stays the storno tool); the note keeps its hand-written
 * gnubok_set_voucher_note, so journal-entries.set-note has no MCP binding.
 */
import { z } from 'zod'
import { CreateJournalEntrySchema, InlineRattelseLineSchema } from '@/lib/api/schemas'
import { isoDateSchema } from '@/lib/invariants/zod'
import {
  correctJournalEntryMetadata,
  getJournalEntryRattelseLog,
  redateJournalEntry,
  strikeJournalEntryLines,
} from '@/lib/core/bookkeeping/journal-entry-corrections'
import { setJournalEntryNote, updateDraftJournalEntry } from '@/lib/core/bookkeeping/journal-entry-edits'
import {
  NO_DOC_BATCH_MAX,
  batchSetNoDocumentRequired,
  clearNoDocumentRequired,
  setNoDocumentRequired,
} from '@/lib/bookkeeping/no-doc-required'
import type { JournalEntry } from '@/types'
import { defineOperation } from './types'

const META_EXAMPLE = { request_id: 'req_…', api_version: '2026-05-12' }

const JOURNAL_ENTRY_ID = z
  .string()
  .uuid()
  .describe('The verifikat id (journal entry UUID), from GET /journal-entries or gnubok_query_journal.')

const INLINE_ENVELOPE_PITFALL =
  'Inline rättelse is only for an open, unlocked period after the company lock date: otherwise 409 JOURNAL_RATTELSE_PERIOD_LOCKED, and storno (POST /journal-entries/{id}/correct) is the only lawful path (BFL 5 kap 5 §).'

// ---------------------------------------------------------------------------
// journal-entries.correct-metadata
// ---------------------------------------------------------------------------

export const journalEntriesCorrectMetadata = defineOperation({
  id: 'journal-entries.correct-metadata',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Correct the description and/or date of a posted verifikat inside the same verifikat (inline rättelse).',
    description:
      'Metadata rättelse (BFL 5 kap 5 § and 9 §): changes the verifikationstext and/or moves the entry date WITHIN its own fiscal period, without a rättelseverifikation. The correct_entry_metadata RPC writes the old and new values with who and when to the immutable rättelse log (GET /journal-entries/{id}/rattelse-log) before it changes anything. Amounts and accounts are never touched here. Idempotent. Dry-runnable: the dry run checks every rule and shows old and new values without writing.',
    useWhen:
      'A posted verifikat in an open, unlocked period has a wrong or unclear description, or a date that is wrong but inside the same fiscal year.',
    doNotUseFor:
      'Moving the entry to another fiscal year (POST /journal-entries/{id}/redate), wrong amounts or accounts (POST /journal-entries/{id}/strike-lines, or /correct once the period is locked), drafts (PATCH /journal-entries/{id}).',
    pitfalls: [
      INLINE_ENVELOPE_PITFALL,
      'A new date outside the entry\'s own fiscal period answers 409 JOURNAL_RATTELSE_REFUSED: use /redate for a cross-period move.',
      'Storno entries are never corrected; opening-balance, year-end and VAT-settlement entries keep their date (409 JOURNAL_RATTELSE_REFUSED).',
      'Values equal to the current ones succeed with changed=false and write no log row.',
    ],
    example: {
      request: { description: 'Hyra lokal september 2026' },
      response: {
        data: {
          changed: true,
          log_id: '5c1e…',
          old_description: 'Hyra',
          new_description: 'Hyra lokal september 2026',
          old_entry_date: '2026-09-01',
          new_entry_date: '2026-09-01',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z
    .object({
      journal_entry_id: JOURNAL_ENTRY_ID,
      description: z
        .string()
        .trim()
        .min(1, 'Beskrivningen kan inte vara tom')
        .max(500)
        .optional()
        .describe('New verifikationstext, at most 500 characters.'),
      entry_date: isoDateSchema.optional().describe('New entry date (YYYY-MM-DD), inside the same fiscal period.'),
    })
    .refine((body) => body.description !== undefined || body.entry_date !== undefined, {
      message: 'Minst ett fält måste anges',
    }),
  output: z.object({
    changed: z.boolean(),
    log_id: z.string().uuid().nullable(),
    old_description: z.string().optional(),
    new_description: z.string().optional(),
    old_entry_date: z.string().optional(),
    new_entry_date: z.string().optional(),
  }),
  errorCodes: [
    'JOURNAL_ENTRY_NOT_FOUND',
    'CANNOT_CORRECT_NON_POSTED',
    'JOURNAL_RATTELSE_REFUSED',
    'JOURNAL_RATTELSE_PERIOD_LOCKED',
    'JOURNAL_RATTELSE_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/journal-entries/:id/correct-metadata',
    pathParams: { id: 'journal_entry_id' },
  },
  mcp: {
    name: 'gnubok_correct_entry_metadata',
    title: 'Correct Voucher Text or Date (Inline Rättelse)',
    description:
      'Stage an inline rättelse of a posted verifikat\'s description and/or date within the same fiscal period, logged with who and when (BFL 5 kap 5 §). Open, unlocked periods only; amounts are untouched. For another year use gnubok_redate_entry.',
    keywords: ['rättelse', 'rätta verifikationstext', 'ändra datum verifikat', 'ändra beskrivning', 'verifikationstext'],
    stage: { pendingType: 'correct_entry_metadata', title: () => 'Rättelse av verifikationstext/datum' },
  },
  run: async (ctx, { journal_entry_id, description, entry_date }, { dryRun }) => {
    const outcome = await correctJournalEntryMetadata(ctx, journal_entry_id, { description, entry_date }, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const d = outcome.data
    return {
      ...outcome,
      data: {
        changed: d.changed === true,
        log_id: (d.log_id as string | null) ?? null,
        ...(d.old_description !== undefined ? { old_description: String(d.old_description) } : {}),
        ...(d.new_description !== undefined ? { new_description: String(d.new_description) } : {}),
        ...(d.old_entry_date !== undefined ? { old_entry_date: String(d.old_entry_date) } : {}),
        ...(d.new_entry_date !== undefined ? { new_entry_date: String(d.new_entry_date) } : {}),
      },
    }
  },
})

// ---------------------------------------------------------------------------
// journal-entries.strike-lines
// ---------------------------------------------------------------------------

export const journalEntriesStrikeLines = defineOperation({
  id: 'journal-entries.strike-lines',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Strike lines of a posted verifikat and add replacement lines inside the same verifikat (inline rättelse).',
    description:
      'Line rättelse (BFL 5 kap 5 §): removes the listed lines from a posted verifikat and adds replacement lines in the same verifikat, without a rättelseverifikation and without a new voucher number. The correct_entry_lines_inline RPC enforces the envelope (posted, open and unlocked period, after the company lock date, at least two lines left, balanced to the öre, SEK only) and snapshots the struck originals with who and when to the immutable rättelse log, so the original stays readable. Standard BAS accounts missing from the chart are added first. Idempotent. Dry-runnable: the dry run shows the struck, added and resulting lines and writes nothing.',
    useWhen:
      'A posted verifikat in an open, unlocked period was booked on the wrong account or with a wrong amount split, e.g. 5410 that should have been 5420, and the user wants it fixed inside the verifikat the way Fortnox "ändra verifikat" does.',
    doNotUseFor:
      'Locked or closed periods (storno: POST /journal-entries/{id}/correct), foreign-currency lines, lines with a linked underlag, storno/year-end/VAT-settlement entries, drafts (PATCH /journal-entries/{id}), or cancelling a whole verifikat (/reverse).',
    pitfalls: [
      INLINE_ENVELOPE_PITFALL,
      'The resulting verifikat must balance (sum debit = sum credit > 0): 400 JOURNAL_ENTRY_NOT_BALANCED otherwise. Amounts are SEK with at most two decimals; account numbers are 4-digit strings.',
      'strike_line_ids must be ids of this verifikat\'s lines (GET /journal-entries/{id}); a line in foreign currency or with a linked underlag cannot be struck (409 JOURNAL_RATTELSE_REFUSED).',
      'A verifikat linked to a bank transaction may only change its bank-account net to the linked bank amount; linked customer/supplier payments keep their 15xx/24xx net. The dry run flags bank_anchor_check; the commit is authoritative.',
      'Striking and re-adding identical lines answers 400 MEANINGLESS_CORRECTION.',
    ],
    example: {
      request: {
        strike_line_ids: ['4b1f…'],
        lines: [{ account_number: '5420', debit_amount: 500, credit_amount: 0, line_description: 'Programvara' }],
      },
      response: {
        data: { log_id: '5c1e…', struck_count: 1, added_count: 1, total_debit: 625, total_credit: 625 },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z
    .object({
      journal_entry_id: JOURNAL_ENTRY_ID,
      strike_line_ids: z
        .array(z.string().uuid())
        .max(200)
        .default([])
        .describe('Ids of the verifikat\'s lines to strike (journal_entry_lines.id).'),
      lines: z
        .array(InlineRattelseLineSchema)
        .max(100)
        .default([])
        .describe('Replacement lines, SEK only: account_number as a 4-digit string, one non-zero side per line.'),
    })
    .refine((body) => body.strike_line_ids.length > 0 || body.lines.length > 0, {
      message: 'Rättelsen måste stryka eller lägga till minst en rad',
    }),
  output: z.object({
    log_id: z.string().uuid(),
    struck_count: z.number().int(),
    added_count: z.number().int(),
    total_debit: z.number(),
    total_credit: z.number(),
  }),
  errorCodes: [
    'JOURNAL_ENTRY_NOT_FOUND',
    'CANNOT_CORRECT_NON_POSTED',
    'JOURNAL_ENTRY_NOT_BALANCED',
    'ACCOUNTS_NOT_IN_CHART',
    'MEANINGLESS_CORRECTION',
    'JOURNAL_RATTELSE_REFUSED',
    'JOURNAL_RATTELSE_PERIOD_LOCKED',
    'JOURNAL_RATTELSE_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/journal-entries/:id/strike-lines',
    pathParams: { id: 'journal_entry_id' },
  },
  mcp: {
    name: 'gnubok_correct_entry_lines',
    title: 'Correct Voucher Lines (Inline Rättelse)',
    description:
      'Stage an inline rättelse: strike lines of a posted verifikat and add balanced replacement lines in the same verifikat, originals kept in the rättelse log (BFL 5 kap 5 §). Open, unlocked periods, SEK only. Locked period: gnubok_correct_entry.',
    keywords: ['rättelse', 'stryk rad', 'ändra verifikat', 'fel konto', 'rätta konto', 'radrättelse'],
    stage: { pendingType: 'correct_entry_lines_inline', title: () => 'Rättelse av rader i verifikat' },
  },
  run: async (ctx, { journal_entry_id, strike_line_ids, lines }, { dryRun }) => {
    const outcome = await strikeJournalEntryLines(
      ctx,
      journal_entry_id,
      {
        strike_line_ids,
        lines: lines.map((l) => ({
          account_number: l.account_number,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
          ...(l.line_description !== undefined ? { line_description: l.line_description } : {}),
          ...(l.dimensions !== undefined ? { dimensions: l.dimensions } : {}),
        })),
      },
      { dryRun },
    )
    if (!outcome.ok || outcome.dryRun) return outcome
    const d = outcome.data
    return {
      ...outcome,
      data: {
        log_id: String(d.log_id),
        struck_count: Number(d.struck_count) || 0,
        added_count: Number(d.added_count) || 0,
        total_debit: Number(d.total_debit) || 0,
        total_credit: Number(d.total_credit) || 0,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// journal-entries.redate
// ---------------------------------------------------------------------------

export const journalEntriesRedate = defineOperation({
  id: 'journal-entries.redate',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Move a posted verifikat to another date, and thereby another period, by storno and re-post.',
    description:
      'Fixes a verifikat booked on the wrong date or year (e.g. 2026-07-03 that should be 2025-07-03). A posted verifikat is immutable, so this is the dashboard\'s "Flytta till annat datum": a storno of the original is posted on the original date (netting it to zero there) and an identical copy is posted on new_entry_date in the period that covers it, the original is marked reversed, and underlag and bank links follow the copy. The chain original, storno, copy stays linked (BFL 5 kap 5 §). Two voucher numbers are used. Idempotent. Dry-runnable: the dry run shows both verifikat with their lines and posts nothing.',
    useWhen:
      'A posted verifikat has the right lines but the wrong date in another fiscal period or year, or the period of its date is past an inline rättelse.',
    doNotUseFor:
      'A date inside the same open period (POST /journal-entries/{id}/correct-metadata keeps one verifikat), wrong lines (/correct), drafts (PATCH /journal-entries/{id}).',
    pitfalls: [
      'The target date must fall in an existing, open, unlocked period: 409 TARGET_PERIOD_CLOSED or TARGET_PERIOD_LOCKED, or 400 NO_OPEN_PERIOD_FOR_DATE (periods are never created here).',
      'The storno lands on the ORIGINAL date: a locked original period answers 400 PERIOD_LOCKED.',
      'The same date answers 400 MEANINGLESS_CORRECTION (details.reason no_date_change).',
      'A chain three or more corrections deep answers 409 CORRECTION_CHAIN_TOO_DEEP; pass allow_deep_chain=true only when another layer is intended.',
    ],
    example: {
      request: { new_entry_date: '2025-07-03' },
      response: {
        data: {
          original_id: '0e9c…',
          reversal_id: '4d2a…',
          corrected_id: '7b3a…',
          voucher_series: 'A',
          reversal_voucher_number: 144,
          corrected_voucher_number: 88,
          new_entry_date: '2025-07-03',
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    journal_entry_id: JOURNAL_ENTRY_ID,
    new_entry_date: isoDateSchema.describe('The correct entry date (YYYY-MM-DD).'),
    allow_deep_chain: z
      .boolean()
      .optional()
      .describe('Override the correction-chain depth guard (3+ levels). True only when another layer is intended.'),
  }),
  output: z.object({
    original_id: z.string().uuid(),
    reversal_id: z.string().uuid(),
    corrected_id: z.string().uuid(),
    voucher_series: z.string(),
    reversal_voucher_number: z.number().int(),
    corrected_voucher_number: z.number().int(),
    new_entry_date: z.string(),
  }),
  errorCodes: [
    'JOURNAL_ENTRY_NOT_FOUND',
    'CANNOT_CORRECT_NON_POSTED',
    'MEANINGLESS_CORRECTION',
    'TARGET_PERIOD_CLOSED',
    'TARGET_PERIOD_LOCKED',
    'NO_OPEN_PERIOD_FOR_DATE',
    'PERIOD_LOCKED',
    'CORRECTION_CHAIN_TOO_DEEP',
    'ACCOUNTS_NOT_IN_CHART',
    'ENTRY_ALREADY_REVERSED',
    'BOOKKEEPING_DATABASE_ERROR',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/journal-entries/:id/redate',
    pathParams: { id: 'journal_entry_id' },
  },
  mcp: {
    name: 'gnubok_redate_entry',
    title: 'Move Voucher to Another Date (Storno and Re-post)',
    description:
      'Stage moving a posted verifikat to another date or year: storno on the original date plus an identical copy on the new date, chain linked (BFL 5 kap 5 §). Preview shows both. Same-period date fix: gnubok_correct_entry_metadata.',
    keywords: ['flytta verifikat', 'fel datum', 'fel år', 'byt period', 'ändra datum', 'omdatera'],
    stage: {
      pendingType: 'redate_entry',
      title: (input) => `Flytta verifikat till ${String(input.new_entry_date ?? '')}`,
    },
  },
  run: async (ctx, { journal_entry_id, new_entry_date, allow_deep_chain }, { dryRun }) => {
    const outcome = await redateJournalEntry(ctx, journal_entry_id, { new_entry_date, allow_deep_chain }, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const { reversal, corrected } = outcome.data
    return {
      ...outcome,
      data: {
        original_id: journal_entry_id,
        reversal_id: reversal.id,
        corrected_id: corrected.id,
        voucher_series: corrected.voucher_series,
        reversal_voucher_number: reversal.voucher_number,
        corrected_voucher_number: corrected.voucher_number,
        new_entry_date: corrected.entry_date,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// journal-entries.update-draft (v1 only)
// ---------------------------------------------------------------------------

const DraftEntryOut = z.object({
  id: z.string().uuid(),
  status: z.string(),
  fiscal_period_id: z.string().uuid(),
  entry_date: z.string(),
  description: z.string(),
  voucher_series: z.string(),
  voucher_number: z.number().int(),
  notes: z.string().nullable(),
  lines: z.array(
    z.object({
      account_number: z.string(),
      debit_amount: z.number(),
      credit_amount: z.number(),
      line_description: z.string().nullable(),
    }),
  ),
})

type DraftLineRow = { account_number: string; debit_amount: number | string; credit_amount: number | string; line_description: string | null }

function toDraftOut(entry: JournalEntry): z.infer<typeof DraftEntryOut> {
  const lines = ((entry as unknown as { lines?: DraftLineRow[] }).lines ?? []).map((l) => ({
    account_number: l.account_number,
    debit_amount: Number(l.debit_amount) || 0,
    credit_amount: Number(l.credit_amount) || 0,
    line_description: l.line_description ?? null,
  }))
  return {
    id: entry.id,
    status: entry.status,
    fiscal_period_id: entry.fiscal_period_id,
    entry_date: entry.entry_date,
    description: entry.description,
    voucher_series: entry.voucher_series,
    voucher_number: entry.voucher_number,
    notes: entry.notes ?? null,
    lines,
  }
}

// Rebuilt from the shape rather than .omit(): source_type, source_id and
// bank_booking_context are fixed at creation and preserved by the engine.
const { fiscal_period_id, entry_date, description, voucher_series, notes, lines } = CreateJournalEntrySchema.shape

export const journalEntriesUpdateDraft = defineOperation({
  id: 'journal-entries.update-draft',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Replace the header and lines of a DRAFT journal entry.',
    description:
      'Edits a draft verifikat in place (fiscal_period_id, entry_date, description, voucher_series, notes and the full line set, which is replaced). Only drafts: a posted entry is refused with 409 CANNOT_EDIT_NON_DRAFT and is corrected with storno or inline rättelse instead. The draft keeps its source_type and source_id and still has no voucher number: POST /journal-entries/{id}/commit posts it. Idempotent. Dry-runnable: the dry run validates balance, period, lock and accounts and writes nothing.',
    useWhen: 'A draft created with POST /journal-entries (or in the dashboard) needs different lines, date or text before it is committed.',
    doNotUseFor: 'Posted verifikat (use /correct, /strike-lines, /correct-metadata or /redate), or only the note (PATCH /journal-entries/{id}/notes).',
    pitfalls: [
      'Send the COMPLETE line set: lines are replaced, not merged.',
      'Lines must balance (sum debit = sum credit > 0): 400 JOURNAL_ENTRY_NOT_BALANCED.',
      'entry_date must fall inside fiscal_period_id: 400 ENTRY_DATE_OUTSIDE_FISCAL_PERIOD; a locked period answers 400 PERIOD_LOCKED.',
      'A standard BAS account missing from the chart is added at commit time of this edit; a deactivated or unknown account fails with ACCOUNTS_NOT_IN_CHART.',
    ],
    example: {
      request: {
        fiscal_period_id: 'a8f1…',
        entry_date: '2026-05-12',
        description: 'Bankavgift maj 2026',
        lines: [
          { account_number: '6570', debit_amount: 60, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 60 },
        ],
      },
      response: {
        data: {
          id: '0e9c…',
          status: 'draft',
          fiscal_period_id: 'a8f1…',
          entry_date: '2026-05-12',
          description: 'Bankavgift maj 2026',
          voucher_series: 'A',
          voucher_number: 0,
          notes: null,
          lines: [
            { account_number: '6570', debit_amount: 60, credit_amount: 0, line_description: null },
            { account_number: '1930', debit_amount: 0, credit_amount: 60, line_description: null },
          ],
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    journal_entry_id: JOURNAL_ENTRY_ID,
    fiscal_period_id,
    entry_date,
    description,
    voucher_series,
    notes,
    lines,
  }),
  output: DraftEntryOut,
  errorCodes: [
    'JOURNAL_ENTRY_NOT_FOUND',
    'CANNOT_EDIT_NON_DRAFT',
    'JOURNAL_ENTRY_NOT_BALANCED',
    'FISCAL_PERIOD_NOT_FOUND',
    'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD',
    'PERIOD_LOCKED',
    'ACCOUNTS_NOT_IN_CHART',
    'JOURNAL_ENTRY_UPDATE_FAILED',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/journal-entries/:id',
    pathParams: { id: 'journal_entry_id' },
  },
  run: async (ctx, { journal_entry_id, ...rest }, { dryRun }) => {
    const outcome = await updateDraftJournalEntry(
      ctx,
      journal_entry_id,
      // source_type is preserved from the stored draft by the engine; the
      // value here only satisfies the shared input type.
      { ...rest, source_type: 'manual' },
      { dryRun },
    )
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: toDraftOut(outcome.data) }
  },
})

// ---------------------------------------------------------------------------
// journal-entries.set-note (v1 only; MCP has gnubok_set_voucher_note)
// ---------------------------------------------------------------------------

export const journalEntriesSetNote = defineOperation({
  id: 'journal-entries.set-note',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Set, replace or clear the internal note (anteckning) on a verifikat.',
    description:
      'The note is annotation metadata beside the verifikat, not räkenskapsinformation: it may be edited on posted entries too, while every bookkeeping field stays immutable (the journal_entries trigger allows a notes-only update and nothing else). null or a blank string clears it. Idempotent. Dry-runnable.',
    useWhen: 'Recording context for a verifikat (who approved it, what an odd booking is about) or clearing an outdated note.',
    doNotUseFor: 'Changing the verifikationstext (POST /journal-entries/{id}/correct-metadata) or anything that belongs in the books.',
    pitfalls: ['At most 2000 characters.', 'The whole note is replaced, not appended to.'],
    example: {
      request: { notes: 'Godkänd av Anna 2026-09-12' },
      response: {
        data: { journal_entry_id: '0e9c…', voucher_series: 'A', voucher_number: 142, notes: 'Godkänd av Anna 2026-09-12' },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    journal_entry_id: JOURNAL_ENTRY_ID,
    notes: z.string().max(2000).nullable().describe('The new note (max 2000 characters); null or blank clears it.'),
  }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().int().nullable(),
    notes: z.string().nullable(),
  }),
  errorCodes: ['JOURNAL_ENTRY_NOT_FOUND', 'JOURNAL_ENTRY_NOTE_FAILED'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/journal-entries/:id/notes',
    pathParams: { id: 'journal_entry_id' },
  },
  run: (ctx, { journal_entry_id, notes: note }, { dryRun }) => setJournalEntryNote(ctx, journal_entry_id, note, { dryRun }),
})

// ---------------------------------------------------------------------------
// "Inget underlag krävs"
// ---------------------------------------------------------------------------

const NO_DOC_REASON = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .optional()
  .describe('Why no external underlag exists, e.g. "Avskrivning enligt plan" (max 200 characters).')

const NO_DOC_BASIS =
  'BFL 5 kap 6 § requires a verifikation for every affärshändelse; where no external underlag exists (avskrivning, periodisering, internal transfer) the verifikation itself is the documentation. The flag records that judgement and removes the entry from the missing-underlag worklist. It is stored beside the verifikat, which is not changed, and the audit log records who set it.'

export const journalEntriesSetNoDocumentRequired = defineOperation({
  id: 'journal-entries.set-no-document-required',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Mark a verifikat as "Inget underlag krävs" (no supporting document required).',
    description: `${NO_DOC_BASIS} Setting it again replaces the reason. Idempotent. Dry-runnable.`,
    useWhen:
      'The user confirms a verifikat has no external underlag by nature (avskrivning, periodisering, bokslutspost, transfer between own accounts) and it should stop showing as missing underlag.',
    doNotUseFor:
      'Hiding a purchase or sale whose receipt or invoice is simply missing: that underlag must be found and attached (POST /documents), not waived.',
    pitfalls: [
      'Only mark what genuinely has no external underlag: a waived receipt is a compliance gap, not a fix.',
      'Undo with DELETE /journal-entries/{id}/no-document-required.',
    ],
    example: {
      request: { reason: 'Avskrivning enligt plan' },
      response: {
        data: { journal_entry_id: '0e9c…', exempted: true, reason: 'Avskrivning enligt plan' },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({ journal_entry_id: JOURNAL_ENTRY_ID, reason: NO_DOC_REASON }),
  output: z.object({ journal_entry_id: z.string().uuid(), exempted: z.literal(true), reason: z.string().nullable() }),
  errorCodes: ['JOURNAL_ENTRY_NOT_FOUND', 'NO_DOC_REQUIRED_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/journal-entries/:id/no-document-required',
    pathParams: { id: 'journal_entry_id' },
  },
  run: async (ctx, { journal_entry_id, reason }, { dryRun }) => {
    const outcome = await setNoDocumentRequired(ctx, journal_entry_id, reason ?? null, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ...outcome, data: { journal_entry_id, exempted: true as const, reason: outcome.data.reason } }
  },
})

export const journalEntriesClearNoDocumentRequired = defineOperation({
  id: 'journal-entries.clear-no-document-required',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Remove the "Inget underlag krävs" mark from a verifikat.',
    description:
      'The verifikat shows as missing underlag again until a document is attached. Clearing a mark that is not set succeeds with removed=false. Idempotent. Dry-runnable.',
    useWhen: 'A verifikat was marked by mistake and does need an underlag.',
    doNotUseFor: 'Detaching a document (documents have their own endpoints).',
    pitfalls: ['The mark is company-shared: any member with write access may clear it; the audit log records who did.'],
    example: {
      response: { data: { journal_entry_id: '0e9c…', exempted: false, removed: true }, meta: META_EXAMPLE },
    },
  },
  input: z.object({ journal_entry_id: JOURNAL_ENTRY_ID }),
  output: z.object({ journal_entry_id: z.string().uuid(), exempted: z.literal(false), removed: z.boolean() }),
  errorCodes: ['NO_DOC_REQUIRED_FAILED'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/journal-entries/:id/no-document-required',
    pathParams: { id: 'journal_entry_id' },
  },
  run: (ctx, { journal_entry_id }, { dryRun }) => clearNoDocumentRequired(ctx, journal_entry_id, { dryRun }),
})

export const journalEntriesBatchNoDocumentRequired = defineOperation({
  id: 'journal-entries.batch-no-document-required',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Mark many posted verifikat as "Inget underlag krävs" in one call.',
    description: `${NO_DOC_BASIS} Only posted verifikat of this company whose type normally needs an underlag are marked; every other id is returned in skipped_ids, never an error. Already-marked entries keep their existing reason. At most ${NO_DOC_BATCH_MAX} ids. Idempotent. Dry-runnable: the dry run lists what would be marked and what is skipped.`,
    useWhen:
      'Clearing many entries that by nature have no external underlag (e.g. historical SIE-imported bokslutsposter) out of the missing-underlag worklist after the user has reviewed them.',
    doNotUseFor: 'Waiving receipts that are missing: find and attach them instead.',
    pitfalls: [
      'Check data.skipped_ids: drafts, reversed entries, other companies\' ids and entry types that never need an underlag are skipped.',
      'data.exempted counts the ids processed, including ones already marked.',
    ],
    example: {
      request: { journal_entry_ids: ['0e9c…', '7b3a…'], reason: 'Bokslutspost, egen handling' },
      response: {
        data: { exempted: 1, journal_entry_ids: ['0e9c…'], skipped_ids: ['7b3a…'] },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({
    journal_entry_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(NO_DOC_BATCH_MAX)
      .describe(`Verifikat ids, 1 to ${NO_DOC_BATCH_MAX}.`),
    reason: NO_DOC_REASON,
  }),
  output: z.object({
    exempted: z.number().int(),
    journal_entry_ids: z.array(z.string().uuid()),
    skipped_ids: z.array(z.string()),
  }),
  errorCodes: ['NO_DOC_REQUIRED_FAILED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/journal-entries/no-document-required' },
  mcp: {
    name: 'gnubok_mark_no_document_required',
    title: 'Mark Vouchers as No Underlag Required',
    description:
      'Stage marking posted verifikat "Inget underlag krävs" (no external underlag by nature: avskrivning, periodisering, bokslutspost). Removes them from the missing-underlag list; verifikat unchanged. Never for a missing receipt.',
    keywords: ['inget underlag krävs', 'saknat underlag', 'underlag saknas', 'egen handling', 'utan underlag'],
    stage: {
      pendingType: 'mark_no_document_required',
      title: (input) => {
        const n = new Set(Array.isArray(input.journal_entry_ids) ? input.journal_entry_ids : []).size
        return n === 1 ? 'Inget underlag krävs för 1 verifikat' : `Inget underlag krävs för ${n} verifikat`
      },
    },
  },
  run: (ctx, { journal_entry_ids, reason }, { dryRun }) =>
    batchSetNoDocumentRequired(ctx, journal_entry_ids, reason ?? null, { dryRun }),
})

// ---------------------------------------------------------------------------
// journal-entries.rattelse-log (read)
// ---------------------------------------------------------------------------

const RattelseLogRow = z.object({
  rattelse_id: z.string().uuid(),
  rattelse_type: z.string().describe('metadata (text/date) or lines (strike and replace).'),
  old_description: z.string().nullable(),
  new_description: z.string().nullable(),
  old_entry_date: z.string().nullable(),
  new_entry_date: z.string().nullable(),
  struck_lines: z.array(z.record(z.string(), z.unknown())).nullable().describe('Snapshots of the struck lines.'),
  added_lines: z.array(z.record(z.string(), z.unknown())).nullable().describe('The lines added in their place.'),
  actor: z.string().uuid().nullable(),
  actor_label: z.string().nullable().describe('Who made the rättelse (profile name or email).'),
  created_at: z.string(),
  source: z.string().nullable().describe('sie_import when the correction history came from an imported SIE file.'),
  external_signature: z.string().nullable().describe('Who corrected it in the source system, for SIE-imported history.'),
})

export const journalEntriesRattelseLog = defineOperation({
  id: 'journal-entries.rattelse-log',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the inline rättelse history of a verifikat, newest first.',
    description:
      'The immutable who/when trail behind every metadata rättelse and line strike on the verifikat (BFL 5 kap 5 §): old and new text and date, snapshots of struck and added lines, the actor and when. Rows with source sie_import carry correction history from an imported SIE file (#BTRANS/#RTRANS) and name the corrector in external_signature. Storno corrections are not here: they are separate verifikat linked by reverses_id/correction_of_id.',
    useWhen: 'Explaining how a verifikat came to look as it does, or checking what an inline rättelse changed before correcting it again.',
    doNotUseFor: 'Storno chains (read the linked verifikat) or the company-wide change history (behandlingshistorik report).',
    pitfalls: ['An entry of another company answers 404, never an empty list.'],
    example: {
      response: {
        data: {
          journal_entry_id: '7b3a…',
          entries: [
          {
            rattelse_id: '5c1e…',
            rattelse_type: 'lines',
            old_description: null,
            new_description: null,
            old_entry_date: null,
            new_entry_date: null,
            struck_lines: [{ account_number: '5410', debit_amount: 500, credit_amount: 0 }],
            added_lines: [{ account_number: '5420', debit_amount: 500, credit_amount: 0 }],
            actor: '9d2b…',
            actor_label: 'Anna Svensson',
            created_at: '2026-09-12T08:14:00Z',
            source: null,
            external_signature: null,
          },
          ],
        },
        meta: META_EXAMPLE,
      },
    },
  },
  input: z.object({ journal_entry_id: JOURNAL_ENTRY_ID }),
  output: z.object({ journal_entry_id: z.string().uuid(), entries: z.array(RattelseLogRow) }),
  errorCodes: ['JOURNAL_ENTRY_NOT_FOUND', 'JOURNAL_RATTELSE_LOG_FAILED'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/journal-entries/:id/rattelse-log',
    pathParams: { id: 'journal_entry_id' },
  },
  mcp: {
    name: 'gnubok_get_rattelse_log',
    title: 'Voucher Rättelse Log',
    description:
      'Read the who/when history of inline rättelser on one verifikat (text/date changes, struck and added lines), newest first. Storno corrections are separate verifikat, not listed here.',
    keywords: ['rättelsehistorik', 'rättelselogg', 'vem ändrade', 'strukna rader', 'ändringshistorik verifikat'],
  },
  // v1 and MCP run on a service-role client, which can read the actor
  // profiles the log names (scoped to those ids).
  run: async (ctx, { journal_entry_id }) => {
    const outcome = await getJournalEntryRattelseLog(ctx, journal_entry_id)
    if (!outcome.ok || outcome.dryRun) return outcome
    // Qualified ids for machine doors (the dashboard reads the service's own rows).
    const entries = (outcome.data as Array<Record<string, unknown>>).map(({ id, ...row }) => ({
      rattelse_id: id as string,
      ...row,
    })) as z.infer<typeof RattelseLogRow>[]
    return { ok: true, data: { journal_entry_id, entries } }
  },
})
