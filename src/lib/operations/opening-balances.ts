/**
 * Ingående balanser typed in by hand, for a year with no closed prior year
 * in Accounted (a company that moved from another system without an SIE
 * file): set them once, correct them later. Rules live in
 * lib/import/opening-balance/service.ts, shared with the dashboard's
 * /api/import/opening-balance/execute and /correct routes.
 *
 * Carrying the IB forward from a CLOSED year is a different action: the
 * hand-written POST /fiscal-periods/{id}/opening-balances and
 * gnubok_set_opening_balances. The spreadsheet parse step
 * (/api/import/opening-balance/parse) stays in the dashboard: the API takes
 * the lines themselves.
 *
 * A correction never edits the posted IB (BFL 5 kap 5 §): the old IB is
 * stornoed and a corrected one is booked and linked. The inline rättelse of
 * single IB lines is journal-entries.strike-lines on the IB verifikat.
 *
 * Splitting an existing IB per project (#3313) is an inline rättelse of the
 * IB verifikat too: lib/import/opening-balance/split-per-project.ts.
 */
import { z } from 'zod'
import { correctOpeningBalances, setOpeningBalances } from '@/lib/import/opening-balance/service'
import {
  previewOpeningBalanceSplit,
  splitOpeningBalancesPerProject,
} from '@/lib/import/opening-balance/split-per-project'
import type { OpeningBalanceLine } from '@/lib/import/opening-balance/execute-helpers'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { roundOre } from '@/lib/money'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const FISCAL_PERIOD_ID = z
  .string()
  .uuid()
  .describe('The fiscal period (räkenskapsår) id the IB belongs to, from GET /fiscal-periods.')

const IbLine = z
  .object({
    account_number: accountNumberSchema.describe('BAS balance sheet account (class 1 or 2), as a string, e.g. "1930".'),
    debit_amount: z.number().finite().nonnegative().optional().describe('Debit in SEK. Give debit_amount/credit_amount or amount, not both.'),
    credit_amount: z.number().finite().nonnegative().optional().describe('Credit in SEK.'),
    amount: z
      .number()
      .finite()
      .optional()
      .describe('Signed balance in SEK instead of debit/credit: positive = debit (assets), negative = credit (liabilities, equity).'),
  })
  .superRefine((line, ctx) => {
    const hasSides = line.debit_amount !== undefined || line.credit_amount !== undefined
    if (hasSides && line.amount !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Give either amount or debit_amount/credit_amount, not both.' })
    }
    if (!hasSides && line.amount === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Give amount or debit_amount/credit_amount.' })
    }
    if ((line.debit_amount ?? 0) > 0 && (line.credit_amount ?? 0) > 0) {
      ctx.addIssue({ code: 'custom', message: 'En verifikationsrad kan inte ha både debet och kredit nollskilda.' })
    }
  })

const IbLines = z.array(IbLine).min(2).max(1000).describe('The IB per account. Zero rows are dropped; debit must equal credit.')

type IbLineInput = z.infer<typeof IbLine>

/** One side per line, rounded to öre. */
function toOpeningBalanceLines(lines: IbLineInput[]): OpeningBalanceLine[] {
  return lines.map((line) => {
    if (line.amount !== undefined) {
      const amount = roundOre(line.amount)
      return {
        account_number: line.account_number,
        debit_amount: amount > 0 ? amount : 0,
        credit_amount: amount < 0 ? roundOre(-amount) : 0,
      }
    }
    return {
      account_number: line.account_number,
      debit_amount: roundOre(line.debit_amount ?? 0),
      credit_amount: roundOre(line.credit_amount ?? 0),
    }
  })
}

const LINES_EXAMPLE = [
  { account_number: '1930', amount: 84250.5 },
  { account_number: '1510', debit_amount: 12500, credit_amount: 0 },
  { account_number: '2440', amount: -9800 },
  { account_number: '2081', amount: -25000 },
  { account_number: '2099', amount: -61950.5 },
]

const LINE_ERRORS = ['OB_TOO_FEW_LINES', 'OB_PNL_ACCOUNT', 'OB_NON_BALANCE_SHEET_ACCOUNT', 'OB_UNBALANCED', 'OB_ACCOUNT_ACTIVATION_FAILED']

// ---------------------------------------------------------------------------
// opening-balances.set-manual
// ---------------------------------------------------------------------------

export const openingBalancesSetManual = defineOperation({
  id: 'opening-balances.set-manual',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a fiscal year\'s ingående balanser (IB) from explicit lines, for a company new to Accounted.',
    description:
      'Posts the IB verifikat (source_type opening_balance, series A, dated the year\'s first day) through the bookkeeping engine and links it to the year, as the dashboard\'s opening balance import does. Lines are balance sheet accounts only (class 1-2), zero rows dropped, at least two left, debit equal to credit. BAS accounts missing from the chart are activated. Refused when the year already has an IB, is closed or locked, or starts on or before the company lock date. Idempotent. Dry-runnable: the dry run previews the verifikat and writes nothing.',
    useWhen:
      'The company moved from another system without an SIE file and its first year in Accounted needs the balances from the previous system\'s balansräkning.',
    doNotUseFor:
      'Carrying the IB forward from a year closed in Accounted (POST /fiscal-periods/{id}/opening-balances, or the year-end which does it), an SIE migration (POST /imports/sie brings its own IB), or changing an IB already booked (POST /fiscal-periods/{id}/opening-balances/correct).',
    pitfalls: [
      'A year that already has an IB answers 409 OB_PERIOD_ALREADY_HAS_BALANCES with details.existingEntryId: correct it instead.',
      'Class 3-8 accounts answer 400 OB_PNL_ACCOUNT, class 0 and 9 400 OB_NON_BALANCE_SHEET_ACCOUNT: an IB holds balance sheet accounts only, earlier years\' results sit in equity (20xx).',
      'Debit and credit must match to the öre: 400 OB_UNBALANCED with details.diff.',
      'A company lock date on or after the year\'s start answers 409 OB_SET_COMPANY_LOCK_DATE; a closed or locked year 400 OB_PERIOD_CLOSED or OB_PERIOD_LOCKED.',
      'The IB is a posted verifikat: it is never edited or deleted, only corrected by storno through /opening-balances/correct.',
    ],
    example: {
      request: { lines: LINES_EXAMPLE },
      response: {
        data: {
          journal_entry_id: '4d2a…',
          voucher_series: 'A',
          voucher_number: 1,
          fiscal_period_id: '7b3a…',
          entry_date: '2026-01-01',
          lines_created: 5,
          total_debit: 96750.5,
          total_credit: 96750.5,
        },
        meta: META,
      },
    },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID, lines: IbLines }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    fiscal_period_id: z.string().uuid(),
    entry_date: z.string(),
    lines_created: z.number(),
    total_debit: z.number(),
    total_credit: z.number(),
  }),
  errorCodes: [
    'OB_PERIOD_NOT_FOUND',
    'OB_PERIOD_CLOSED',
    'OB_PERIOD_LOCKED',
    'OB_PERIOD_ALREADY_HAS_BALANCES',
    'OB_SET_COMPANY_LOCK_DATE',
    ...LINE_ERRORS,
    'OB_EXECUTE_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/manual',
    pathParams: { id: 'fiscal_period_id' },
  },
  mcp: {
    name: 'gnubok_set_opening_balances_manual',
    title: 'Set Opening Balances Manually (Ingående Balans)',
    description:
      'Stage the first ingående balanser of a year from explicit lines (class 1-2, balanced), for a company new to Accounted without SIE. Refused if the year already has an IB. For a year closed here use gnubok_set_opening_balances.',
    keywords: ['ingående balans', 'ingående balanser', 'ib', 'öppningsbalans', 'startbalans', 'flytta från annat system', 'balansräkning förra året'],
    stage: { pendingType: 'set_opening_balances_manual', title: () => 'Bokför ingående balanser' },
  },
  run: (ctx, input, { dryRun }) =>
    setOpeningBalances(
      ctx,
      { fiscal_period_id: input.fiscal_period_id, lines: toOpeningBalanceLines(input.lines) },
      { dryRun, balanceSheetOnly: true },
    ),
})

// ---------------------------------------------------------------------------
// opening-balances.correct
// ---------------------------------------------------------------------------

const CascadePeriod = z.object({
  fiscal_period_id: z.string(),
  period_name: z.string().nullable(),
  journal_entry_id: z.string(),
  reversed_entry_id: z.string().nullable(),
})

export const openingBalancesCorrect = defineOperation({
  id: 'opening-balances.correct',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Correct a year\'s ingående balanser by storno: the full corrected IB replaces the old one.',
    description:
      'Books the corrected IB verifikat from the lines given (the complete IB, not a difference), stornoes the old IB verifikat and relinks the year to the new one (BFL 5 kap 5 §: nothing posted is edited). The new verifikat\'s text references the one it corrects. With cascade=true the per-account change is also carried into every later year\'s IB; years that are closed, locked, behind the lock date or have a bokslut are skipped and reported. Only for an open, unlocked year with an IB and no bokslut. Idempotent. Dry-runnable: the dry run previews the new verifikat and the per-account change and writes nothing.',
    useWhen: 'The IB booked for a year was wrong (a typo, a balance the previous system corrected later).',
    doNotUseFor:
      'A year without an IB (POST /fiscal-periods/{id}/opening-balances/manual), a single wrong line in an open year (POST /journal-entries/{id}/strike-lines on the IB verifikat corrects inside the same verifikat), or a year that is locked, closed or has a bokslut (unwind those first).',
    pitfalls: [
      'Send the COMPLETE corrected IB: accounts left out end at zero.',
      'A year without an IB answers 409 OB_CORRECT_NO_EXISTING; one with a posted bokslut 409 OB_CORRECT_YEAR_END_EXISTS.',
      'A company lock date on or after the year\'s start answers 409 OB_COMPANY_LOCK_DATE.',
      'If the storno or relink fails the new IB is stornoed again and 500 OB_CORRECT_FAILED names both entry ids: the year keeps its old IB.',
      'cascade is best effort per later year: read cascade.skipped in the response and correct those years by hand.',
    ],
    example: {
      request: { lines: LINES_EXAMPLE, cascade: true },
      response: {
        data: {
          journal_entry_id: '8c1e…',
          voucher_series: 'A',
          voucher_number: 42,
          reversed_entry_id: '4d2a…',
          fiscal_period_id: '7b3a…',
          lines_created: 5,
          total_debit: 96750.5,
          total_credit: 96750.5,
          cascade: { corrected: [], skipped: [] },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    fiscal_period_id: FISCAL_PERIOD_ID,
    lines: IbLines,
    cascade: z.boolean().optional().describe('Also carry the per-account change into every later year\'s IB. Default false.'),
  }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    reversed_entry_id: z.string().uuid().describe('The old IB verifikat, now stornoed.'),
    fiscal_period_id: z.string().uuid(),
    lines_created: z.number(),
    total_debit: z.number(),
    total_credit: z.number(),
    cascade: z
      .object({
        corrected: z.array(CascadePeriod),
        skipped: z.array(z.object({ fiscal_period_id: z.string(), period_name: z.string().nullable(), reason: z.string() })),
        failed: z.boolean().optional(),
      })
      .optional(),
  }),
  errorCodes: [
    'OB_PERIOD_NOT_FOUND',
    'OB_PERIOD_CLOSED',
    'OB_PERIOD_LOCKED',
    'OB_COMPANY_LOCK_DATE',
    'OB_CORRECT_NO_EXISTING',
    'OB_CORRECT_YEAR_END_EXISTS',
    ...LINE_ERRORS,
    'OB_CORRECT_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/correct',
    pathParams: { id: 'fiscal_period_id' },
  },
  mcp: {
    name: 'gnubok_correct_opening_balances',
    title: 'Correct Opening Balances (Ingående Balans)',
    description:
      'Stage an IB correction by storno: book the complete corrected ingående balanser, reverse the old IB verifikat, relink the year. Optional cascade to later years. Open, unlocked year without bokslut only.',
    keywords: ['rätta ingående balans', 'korrigera ingående balans', 'fel ingående balans', 'ändra ib', 'storno ib'],
    stage: { pendingType: 'correct_opening_balances', title: () => 'Rätta ingående balanser' },
  },
  run: (ctx, input, { dryRun }) =>
    correctOpeningBalances(
      ctx,
      { fiscal_period_id: input.fiscal_period_id, lines: toOpeningBalanceLines(input.lines), cascade: input.cascade },
      { dryRun, balanceSheetOnly: true },
    ),
})

// ---------------------------------------------------------------------------
// opening-balances.split-per-project (+ its read-only preview)
// ---------------------------------------------------------------------------

const SplitLine = z.object({
  debit_amount: z.number(),
  credit_amount: z.number(),
  amount: z.number().describe('Signed: debit positive.'),
  dimensions: z.record(z.string(), z.string()).describe('The line\'s bag, e.g. {"6":"P1"}; {} for the untagged remainder.'),
  line_description: z.string().nullable(),
})

const SplitBlocked = z
  .object({
    code: z.string(),
    message_sv: z.string(),
    message_en: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable()

const SplitPreviewOutput = z.object({
  fiscal_period_id: z.string().uuid(),
  fiscal_period_name: z.string().nullable(),
  journal_entry_id: z.string().uuid().nullable().describe('The IB verifikat the split corrects in place.'),
  voucher: z.string().nullable(),
  source: z.literal('previous_year'),
  source_fiscal_period_id: z.string().uuid().nullable(),
  source_fiscal_period_name: z.string().nullable(),
  source_period_closed: z.boolean().nullable().describe('False while the previous year is still open: its balances may still move.'),
  accumulating_dimensions: z.array(z.string()).describe('SIE numbers of the dimensions whose balances carry (resets_annually = false), e.g. ["6"].'),
  method: z.literal('inline_rattelse'),
  accounts_to_change: z.number(),
  accounts_unchanged: z.number(),
  accounts_skipped: z.number(),
  can_apply: z.boolean(),
  blocked: SplitBlocked.describe('Why the split cannot run now: the code the apply answers, with the Swedish message.'),
  unresolved_dimensions: z.array(
    z.object({
      sie_dim_no: z.string(),
      code: z.string(),
      reason: z.enum(['unknown_dimension', 'resetting_dimension', 'unknown_value']),
      accounts: z.array(z.string()),
    }),
  ),
  dimension_values: z.array(z.object({ sie_dim_no: z.string(), code: z.string(), name: z.string(), is_active: z.boolean() })),
  accounts: z.array(
    z.object({
      account_number: z.string(),
      account_name: z.string().nullable(),
      total: z.number().describe('The account\'s IB, unchanged by the split.'),
      status: z.enum(['change', 'unchanged', 'skipped']),
      skip_reason: z.enum(['foreign_currency', 'line_document']).nullable(),
      current_lines: z.array(SplitLine.extend({ journal_entry_line_id: z.string().uuid() })),
      proposed_lines: z.array(SplitLine),
    }),
  ),
  fingerprint: z.string().describe('Pass as expected_fingerprint to apply exactly this split.'),
})

const SPLIT_PREVIEW_EXAMPLE = {
  fiscal_period_id: '7b3a…',
  fiscal_period_name: '2026',
  journal_entry_id: '4d2a…',
  voucher: 'A1',
  source: 'previous_year',
  source_fiscal_period_id: '5e91…',
  source_fiscal_period_name: '2025',
  source_period_closed: true,
  accumulating_dimensions: ['6'],
  method: 'inline_rattelse',
  accounts_to_change: 1,
  accounts_unchanged: 0,
  accounts_skipped: 0,
  can_apply: true,
  blocked: null,
  unresolved_dimensions: [],
  dimension_values: [{ sie_dim_no: '6', code: 'P1', name: 'Kv. Eken', is_active: true }],
  accounts: [
    {
      account_number: '1470',
      account_name: 'Pågående arbeten',
      total: 1800,
      status: 'change',
      skip_reason: null,
      current_lines: [
        { journal_entry_line_id: '9c0f…', debit_amount: 1800, credit_amount: 0, amount: 1800, dimensions: {}, line_description: 'IB 1470' },
      ],
      proposed_lines: [
        { debit_amount: 1300, credit_amount: 0, amount: 1300, dimensions: { '6': 'P1' }, line_description: 'Ingående balans: Pågående arbeten' },
        { debit_amount: 500, credit_amount: 0, amount: 500, dimensions: {}, line_description: 'Ingående balans: Pågående arbeten' },
      ],
    },
  ],
  fingerprint: '3f9a…',
}

const SPLIT_ERRORS = [
  'OB_PERIOD_NOT_FOUND',
  'OB_CORRECT_NO_EXISTING',
  'OB_SPLIT_NO_PREVIOUS_YEAR',
  'OB_SPLIT_PERIOD_CLOSED',
  'OB_SPLIT_PERIOD_LOCKED',
  'OB_COMPANY_LOCK_DATE',
  'OB_CORRECT_YEAR_END_EXISTS',
  'OB_SPLIT_DIMENSION_UNRESOLVED',
]

const SPLIT_PATH = '/api/v1/companies/:companyId/fiscal-periods/:id/opening-balances/split-per-project'

export const openingBalancesSplitPreview = defineOperation({
  id: 'opening-balances.split-per-project-preview',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Preview splitting a year\'s ingående balanser per project from the previous year\'s tagged closing balances.',
    description:
      'For the year\'s IB verifikat, computes the per-project split of each balance sheet account from the previous fiscal year\'s closing balances per object of the dimensions that carry across years (registry resets_annually = false: projekt, dimension 6). Each such account becomes one line per project plus one untagged remainder (the current IB minus the projects, any sign); the account total never changes. Accounts without a project balance last year, and the VAT accounts (26xx), stay untouched. Answers current and proposed lines per account, which accounts change, unresolved project codes, and blocked (code and Swedish message) when the year is closed, locked, behind the lock date or has a bokslut. Read-only.',
    useWhen:
      'A project-filtered ledger opens at zero for a year whose IB was booked before project balances were carried (an IB imported or closed earlier), and the user asks how project balances carry into the new year.',
    doNotUseFor:
      'Changing amounts in the IB (POST /fiscal-periods/{id}/opening-balances/correct) or a year closed after project balances were carried: the year-end already splits the IB per project.',
    pitfalls: [
      'The basis is the previous year in Accounted as it stands: if that year is still open (source_period_closed false), later bookings there change the split.',
      'A previous year whose own IB was untagged only carries the projects\' movements of that year.',
      'unresolved_dimensions lists codes missing from the registry: the apply refuses until they exist.',
    ],
    example: { response: { data: SPLIT_PREVIEW_EXAMPLE, meta: META } },
  },
  input: z.object({ fiscal_period_id: FISCAL_PERIOD_ID }),
  output: SplitPreviewOutput,
  errorCodes: ['OB_PERIOD_NOT_FOUND', 'OB_SPLIT_FAILED'],
  http: { method: 'GET', path: SPLIT_PATH, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_preview_opening_balance_split',
    title: 'Preview Opening Balance Split Per Project',
    description:
      'Preview splitting a year\'s ingående balanser per project (dimension 6) from last year\'s tagged closing balances: current vs proposed lines per account, totals unchanged, what blocks it. Read-only; apply with gnubok_split_opening_balances_per_project.',
    keywords: ['ingående balans per projekt', 'projektsaldo', 'ib per projekt', 'dela upp ib', 'projekt ingående balans', 'föra över projektsaldon'],
  },
  run: (ctx, input) => previewOpeningBalanceSplit(ctx, { fiscal_period_id: input.fiscal_period_id }),
})

export const openingBalancesSplitPerProject = defineOperation({
  id: 'opening-balances.split-per-project',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Split a year\'s ingående balanser per project, inside the same IB verifikat (inline rättelse).',
    description:
      'Applies the split GET /fiscal-periods/{id}/opening-balances/split-per-project previews: for each changing account the IB verifikat\'s lines are struck and replaced by one line per project plus an untagged remainder, inside the same verifikat through the inline rättelse (BFL 5 kap 5 §; the struck lines are kept in the rättelse log with who and when). Account totals never change. Every project code is checked against the dimension registry first; archived projects are kept. Only for an open, unlocked year after the lock date and without a bokslut; there is no storno fallback, because a storno-corrected IB carries no project tags. A split already in place answers applied=false and writes nothing. Idempotent. Dry-runnable: the dry run answers the preview.',
    useWhen:
      'The user wants project balances carried into a year whose IB was booked as one line per account, after reviewing the preview.',
    doNotUseFor:
      'Changing IB amounts (POST /fiscal-periods/{id}/opening-balances/correct), or a locked or closed year: open it first.',
    pitfalls: [
      'Pass expected_fingerprint from the preview: if the IB or the previous year changed since, 409 OB_SPLIT_PROPOSAL_CHANGED instead of a different split.',
      'A closed year answers 409 OB_SPLIT_PERIOD_CLOSED, a locked one 409 OB_SPLIT_PERIOD_LOCKED, a lock date covering the IB 409 OB_COMPANY_LOCK_DATE, a posted bokslut 409 OB_CORRECT_YEAR_END_EXISTS.',
      'Project codes missing from the registry answer 409 OB_SPLIT_DIMENSION_UNRESOLVED with details.unresolved.',
      'An account with a foreign-currency IB line or a line-level underlag link is skipped (accounts_skipped), never forced.',
    ],
    example: {
      request: { expected_fingerprint: '3f9a…' },
      response: {
        data: {
          fiscal_period_id: '7b3a…',
          journal_entry_id: '4d2a…',
          applied: true,
          accounts_changed: ['1470'],
          accounts_skipped: [],
          lines_struck: 1,
          lines_added: 2,
          rattelse_log_ids: ['b7d2…'],
          fingerprint: '3f9a…',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    fiscal_period_id: FISCAL_PERIOD_ID,
    expected_fingerprint: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('fingerprint from the preview you reviewed. The split is refused if it changed since.'),
  }),
  output: z.object({
    fiscal_period_id: z.string().uuid(),
    journal_entry_id: z.string().uuid().describe('The IB verifikat, corrected in place (same id).'),
    applied: z.boolean().describe('False when the IB already matched the split: nothing was written.'),
    accounts_changed: z.array(z.string()),
    accounts_skipped: z.array(z.object({ account_number: z.string(), reason: z.enum(['foreign_currency', 'line_document']) })),
    lines_struck: z.number(),
    lines_added: z.number(),
    rattelse_log_ids: z.array(z.string().uuid()),
    fingerprint: z.string(),
  }),
  errorCodes: [...SPLIT_ERRORS, 'OB_SPLIT_PROPOSAL_CHANGED', 'OB_SPLIT_REFUSED', 'OB_SPLIT_FAILED'],
  http: { method: 'POST', path: SPLIT_PATH, pathParams: { id: 'fiscal_period_id' } },
  mcp: {
    name: 'gnubok_split_opening_balances_per_project',
    title: 'Split Opening Balances Per Project',
    description:
      'Stage splitting a year\'s IB verifikat per project from last year\'s tagged closing balances, as an inline rättelse of the same verifikat. Totals unchanged; open, unlocked year without bokslut only. Preview first with gnubok_preview_opening_balance_split.',
    keywords: ['dela upp ingående balans per projekt', 'ib per projekt', 'projektsaldon nytt år', 'föra över projektsaldon'],
    stage: {
      pendingType: 'split_opening_balances_per_project',
      title: () => 'Dela upp ingående balanser per projekt',
      // The approver saw this split: the commit must apply the same one.
      pinParams: (input, preview) =>
        typeof preview.fingerprint === 'string' ? { ...input, expected_fingerprint: preview.fingerprint } : input,
    },
  },
  run: (ctx, input, { dryRun }) =>
    splitOpeningBalancesPerProject(
      ctx,
      { fiscal_period_id: input.fiscal_period_id, expected_fingerprint: input.expected_fingerprint },
      { dryRun },
    ),
})
