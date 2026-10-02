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
 */
import { z } from 'zod'
import { correctOpeningBalances, setOpeningBalances } from '@/lib/import/opening-balance/service'
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
