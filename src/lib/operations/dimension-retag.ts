/**
 * Retagging posted lines and reading their retag history, over the API.
 *
 * dimensions.retag-lines is v1 only: MCP already has gnubok_tag_journal_lines,
 * which selects the lines by a filter, stages, and runs the same
 * lib/dimensions/retag-service.ts at approval, so no tool exists twice. Both
 * doors take the same request fields (RETAG_REQUEST_SHAPE) and the same
 * merge/replace semantics; the API default is merge, as in the workbench.
 *
 * dimensions.retag-log reads dimension_retag_log, which no door served.
 */
import { z } from 'zod'
import { RETAG_REQUEST_SHAPE } from '@/lib/pending-operations/schemas/retag-line-dimensions'
import { everyRetagRefused, RETAG_MODES, retagLines } from '@/lib/dimensions/retag-service'
import { listDimensionRetagLog } from '@/lib/dimensions/retag-log'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const BAG = z.record(z.string(), z.string())
const LINE_FAILURE = z.object({ line_id: z.string().uuid(), error: z.string().describe('Why the line was refused (Swedish).') })

export const dimensionsRetagLines = defineOperation({
  id: 'dimensions.retag-lines',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change the dimension tags (kostnadsställe, projekt) on posted journal lines.',
    description:
      'Sets dimension tags on lines of posted verifikat, the one thing about a posted line that may change: amounts, accounts and texts never do. mode merge (default) sets the pairs in `dimensions` and keeps every other dimension the line carries; replace makes the line\'s tags exactly `dimensions`. Each line is its own transaction through the audited retag path, which writes an immutable before/after row with the reason (GET /dimensions/retag-log) and refuses a line in a closed or locked period, on or before the bookkeeping lock date, on a draft, or with a code that is not an active registry value. Partial success is success: refused lines are listed in failed. Idempotent. Dry-runnable: the dry run shows each line\'s tags before and after.',
    useWhen:
      'Posted lines lack a project or cost centre, or carry the wrong one, and you know the line ids (lines[].id of GET /journal-entries/{id}).',
    doNotUseFor:
      'Changing amounts, accounts or dates (a rättelse: POST /journal-entries/{id}/correct), tagging lines of a draft (edit the draft), or clearing every tag of a line (the dashboard only).',
    pitfalls: [
      'Codes are STRINGS keyed by sie_dim_no: {"6": "P001"}, and each must be an active value in the registry (GET /dimensions).',
      'merge keeps the line\'s other tags, and those must still be active registry values too: a line carrying an archived code is refused until the code is reactivated or replace is used.',
      'At most 500 line ids per call; the reason (3-500 characters) is stored per line.',
      'When every line is refused the call answers 400 DIMENSION_RETAG_FAILED with details.failed; otherwise it answers 200 with the refused lines in failed.',
    ],
    example: {
      request: {
        line_ids: ['9f1c…', '9f1d…'],
        dimensions: { '6': 'P001' },
        reason: 'Projektet saknades på fakturan',
      },
      response: {
        data: { retagged: 2, unchanged: 0, failed_count: 0, failed: [], mode: 'merge' },
        meta: META,
      },
    },
  },
  input: z
    .object({
      ...RETAG_REQUEST_SHAPE,
      mode: z
        .enum(RETAG_MODES)
        .default('merge')
        .describe('merge (default) keeps each line\'s other dimensions; replace makes its tags exactly `dimensions`.'),
    })
    .strict(),
  output: z.object({
    retagged: z.number().int().describe('Lines whose tags changed.'),
    unchanged: z.number().int().describe('Lines that already carried the resulting tags.'),
    failed_count: z.number().int(),
    failed: z.array(LINE_FAILURE),
    mode: z.enum(RETAG_MODES),
  }),
  errorCodes: ['DIMENSION_RETAG_FAILED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/dimensions/retag' },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await retagLines(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const { retagged, unchanged, failed } = outcome.data
    const refused = everyRetagRefused(outcome.data)
    if (refused) {
      return {
        ok: false,
        code: 'DIMENSION_RETAG_FAILED',
        messageSv: refused.messageSv,
        details: { failed_count: failed.length, failed },
      }
    }
    return { ok: true, data: { retagged, unchanged, failed_count: failed.length, failed, mode: input.mode } }
  },
})

const RetagLogRow = z.object({
  retag_log_id: z.string().uuid(),
  journal_entry_id: z.string().uuid(),
  line_id: z.string().uuid(),
  old_dimensions: BAG,
  new_dimensions: BAG,
  actor: z.string().uuid().nullable().describe('The user the retag was made as.'),
  reason: z.string(),
  created_at: z.string(),
})

export const dimensionsRetagLog = defineOperation({
  id: 'dimensions.retag-log',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read the history of dimension tag changes on posted lines, newest first.',
    description:
      'The immutable trail behind every retag of a posted line: the tags before and after, who made the change, when and why. Filter by journal_entry_id and/or line_id, or read the whole company\'s history. The log outlives its lines (an undone SIE import deletes the verifikat, not the history). Paged with limit and offset: total_count, has_more and next_offset say what is left.',
    useWhen: 'Explaining why a line carries its project or cost centre, or auditing who changed dimension tags on booked history.',
    doNotUseFor: 'Rättelser of amounts, accounts or texts (GET /journal-entries/{id}/rattelse-log) or the company-wide change history (GET /audit-trail).',
    pitfalls: [
      'An id of another company matches nothing: the answer is an empty page, not a 404.',
      'Tags set when the line was booked are not here: only later changes are.',
    ],
    example: {
      response: {
        data: {
          entries: [
            {
              retag_log_id: '1c2d…',
              journal_entry_id: '7b3a…',
              line_id: '9f1c…',
              old_dimensions: { '1': 'KS01' },
              new_dimensions: { '1': 'KS01', '6': 'P001' },
              actor: '9d2b…',
              reason: 'Projektet saknades på fakturan',
              created_at: '2026-09-28T09:14:00Z',
            },
          ],
          count: 1,
          total_count: 1,
          has_more: false,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    journal_entry_id: z.string().uuid().optional().describe('Only changes to lines of this verifikat.'),
    line_id: z.string().uuid().optional().describe('Only changes to this line.'),
    limit: z.coerce.number().int().min(1).max(200).default(50).describe('Page size, 1-200 (default 50).'),
    offset: z.coerce.number().int().min(0).default(0).describe('Rows to skip (next_offset of the previous page).'),
  }),
  output: z.object({
    entries: z.array(RetagLogRow),
    count: z.number().int(),
    total_count: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().optional(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/dimensions/retag-log' },
  mcp: {
    name: 'gnubok_list_dimension_retag_log',
    title: 'Dimension Retag Log',
    description:
      'Read who changed the dimension tags (kostnadsställe, projekt) on posted lines, when, why, and the tags before and after, newest first. Filter by journal_entry_id or line_id; paged with offset.',
    keywords: ['omtaggning', 'dimensionshistorik', 'ändrade dimensioner', 'vem taggade om', 'retag'],
  },
  run: (ctx, input) => listDimensionRetagLog(ctx, input),
})
