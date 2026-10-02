/**
 * Momsredovisning (VAT settlement) operations: read the proposed verifikat
 * that clears a VAT period's 26xx accounts to 2650/1650, and book exactly
 * that proposal. Rules live in lib/reports/vat-settlement-booking.ts over
 * the proposal builder the dashboard uses (lib/reports/vat-settlement.ts).
 *
 * The dashboard books the proposal through the journal entry form, where the
 * user may edit the lines first (POST /api/bookkeeping/journal-entries with
 * source_type 'vat_settlement'). The API books the server's proposal as is;
 * an integrator who needs other lines posts an ordinary verifikat.
 */
import { z } from 'zod'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import { defineOperation } from './types'

// Loaded on first use: the proposal builder pulls in the VAT declaration
// graph, which the operation registry's importers (MCP server, commit path)
// do not otherwise need.
const settlement = () => import('@/lib/reports/vat-settlement-booking')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const PERIOD_FIELDS = {
  period_type: z.enum(['monthly', 'quarterly', 'yearly']).describe('The momsperiod length.'),
  year: z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100)
    .describe('Calendar year of the period; for yearly, the year the räkenskapsår ends.'),
  period: z.coerce.number().int().min(1).max(12).describe('1-12 monthly, 1-4 quarterly, 1 yearly.'),
  fiscal_period_id: z
    .string()
    .uuid()
    .optional()
    .describe('Yearly (helårsmoms) only: the räkenskapsår whose bounds the period takes, for a broken fiscal year.'),
}

type PeriodFields = { period_type: string; period: number }

function periodBounds(data: PeriodFields, ctx: z.RefinementCtx) {
  if (data.period_type === 'quarterly' && data.period > 4) {
    ctx.addIssue({ code: 'custom', path: ['period'], message: 'For quarterly period_type, period must be 1-4.' })
  }
  if (data.period_type === 'yearly' && data.period !== 1) {
    ctx.addIssue({ code: 'custom', path: ['period'], message: 'For yearly period_type, period must be 1.' })
  }
}

/** A momsperiod as the query of the proposal, the booking and the eSKD file take it. */
export const VatPeriodInputSchema = z.object(PERIOD_FIELDS).superRefine(periodBounds)

const ProposalLine = z.object({
  account_number: z.string().describe('BAS account, as a string.'),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().optional(),
})

const ExistingEntry = z.object({
  journal_entry_id: z.string().uuid().describe('The settlement verifikat.'),
  status: z.string(),
  entry_date: z.string(),
  source_type: z.string().nullable(),
  voucher_series: z.string().nullable(),
  voucher_number: z.number().nullable(),
})

const EXAMPLE_LINES = [
  { account_number: '2611', debit_amount: 25000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 0, credit_amount: 6250.4 },
  { account_number: '2650', debit_amount: 0, credit_amount: 18749, line_description: 'Moms att betala' },
  { account_number: '3740', debit_amount: 0, credit_amount: 0.6, line_description: 'Öres- och kronutjämning' },
]

export const reportsVatSettlementProposal = defineOperation({
  id: 'reports.vat-settlement-proposal',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The proposed momsredovisning verifikat for a VAT period: clear 26xx to 2650 or 1650.',
    description:
      'Builds the settlement entry for a momsperiod from the same ledger totals as the momsdeklaration: every output VAT account (261x-263x, reverse charge and import included) debited and every input VAT account (264x) credited by its period balance at exact öre, the net to 2650 (att betala, credit) or 1650 (att återfå, debit) at the whole-krona amount the declaration is filed with (ruta 49), and the öre gap on 3740. Dated the period\'s last day. existing_entries lists settlements already booked or drafted in the period (tagged vat_settlement or recognised by shape); booking_status sums them up. fingerprint identifies these exact lines. Read-only.',
    useWhen: 'Before booking the VAT for a period (POST /vat/settlement), to review what will be posted.',
    doNotUseFor: 'The declaration rutor themselves (GET /reports/vat-declaration) or paying the VAT (the skattekonto payment is booked separately).',
    pitfalls: [
      'booking_status booked means a posted settlement exists: booking again is refused; reverse that verifikat first if the period must be re-booked.',
      'is_empty true means the period has no VAT to clear.',
      'The proposal clears the WHOLE period, not the change since an earlier settlement.',
    ],
    example: {
      request: { period_type: 'quarterly', year: 2026, period: 1 },
      response: {
        data: {
          period: { type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31' },
          period_label: 'Kvartal 1 2026',
          entry_date: '2026-03-31',
          description: 'Momsredovisning Kvartal 1 2026',
          lines: EXAMPLE_LINES,
          filed_net: 18749,
          rounding_amount: 0.6,
          is_empty: false,
          existing_entries: [],
          booking_status: 'none',
          fingerprint: '3f9a…',
        },
        meta: META,
      },
    },
  },
  input: VatPeriodInputSchema,
  output: z.object({
    period: z.object({
      type: z.enum(['monthly', 'quarterly', 'yearly']),
      year: z.number(),
      period: z.number(),
      start: z.string(),
      end: z.string(),
    }),
    period_label: z.string(),
    entry_date: z.string(),
    description: z.string(),
    lines: z.array(ProposalLine),
    filed_net: z.number().describe('Ruta 49 as filed, whole kronor; positive = att betala.'),
    rounding_amount: z.number().describe('Signed öre gap balanced on 3740 (positive = credited).'),
    is_empty: z.boolean(),
    existing_entries: z.array(ExistingEntry),
    booking_status: z.enum(['booked', 'draft', 'none']),
    fingerprint: z.string(),
  }),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'VAT_REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/vat-declaration/settlement-proposal' },
  mcp: {
    name: 'gnubok_get_vat_settlement_proposal',
    title: 'VAT Settlement Proposal (Momsredovisning)',
    description:
      'The momsredovisning verifikat a VAT period needs: 26xx cleared to 2650 (att betala) or 1650 (att återfå) at the filed whole-krona amount, öre gap on 3740, plus any settlement already booked. Book it with gnubok_book_vat_settlement.',
    keywords: ['momsredovisning', 'momsomföring', 'bokför moms', 'momsavräkning', '2650', 'nollställ momskonton'],
  },
  run: async (ctx, input) => {
    const outcome = await (await settlement()).getVatSettlementProposal(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    // Qualified ids on the machine doors (qualified-ids.test.ts): the
    // dashboard's proposal names the verifikat `id`.
    return {
      ok: true,
      data: {
        ...outcome.data,
        existing_entries: outcome.data.existing_entries.map(({ id, ...entry }) => ({ journal_entry_id: id, ...entry })),
      },
    }
  },
})

export const vatBookSettlement = defineOperation({
  id: 'vat.book-settlement',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book the momsredovisning verifikat for a VAT period, exactly as the proposal gives it.',
    description:
      'Posts the settlement proposal of GET /reports/vat-declaration/settlement-proposal as a verifikat (source_type vat_settlement) through the bookkeeping engine: 26xx cleared, the net on 2650 or 1650 at the filed whole-krona amount, the öre gap on 3740, dated the period\'s last day. The lines are the server\'s, never the caller\'s. Refused when a settlement is already posted in the period, when there is nothing to clear, when expected_fingerprint no longer matches, or when the date is locked. The declaration projection excludes vat_settlement entries, so the momsdeklaration does not change. Idempotent. Dry-runnable: the dry run previews the verifikat and writes nothing.',
    useWhen: 'The VAT period is reviewed (and usually filed) and the 26xx accounts should be cleared to the skattekonto liability.',
    doNotUseFor:
      'Filing the momsdeklaration with Skatteverket (the eSKD file or the Skatteverket connection), booking the payment to the skattekonto, or custom settlement lines (post an ordinary verifikat with POST /journal-entries).',
    pitfalls: [
      'A posted settlement in the period answers 409 VAT_SETTLEMENT_ALREADY_BOOKED with details.journal_entry_id: reverse it first if the period must be re-booked.',
      'Pass expected_fingerprint from the proposal you reviewed: if the ledger changed since, 409 VAT_SETTLEMENT_PROPOSAL_CHANGED instead of booking different lines.',
      'A locked or closed period, or a date on or before the company lock date, answers 400 PERIOD_LOCKED; no voucher number is spent.',
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.',
    ],
    example: {
      request: { period_type: 'quarterly', year: 2026, period: 1, expected_fingerprint: '3f9a…' },
      response: {
        data: {
          journal_entry_id: '9a0b…',
          voucher_series: 'A',
          voucher_number: 57,
          entry_date: '2026-03-31',
          period_label: 'Kvartal 1 2026',
          filed_net: 18749,
          rounding_amount: 0.6,
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      ...PERIOD_FIELDS,
      expected_fingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe('fingerprint from the proposal you reviewed. The booking is refused if the proposal changed since.'),
    })
    .superRefine(periodBounds),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    entry_date: z.string(),
    period_label: z.string(),
    filed_net: z.number(),
    rounding_amount: z.number(),
  }),
  errorCodes: [
    'FISCAL_PERIOD_NOT_FOUND',
    'VAT_SETTLEMENT_ALREADY_BOOKED',
    'VAT_SETTLEMENT_EMPTY',
    'VAT_SETTLEMENT_PROPOSAL_CHANGED',
    'PERIOD_LOCKED',
    'VAT_SETTLEMENT_NO_FISCAL_PERIOD',
    'VAT_SETTLEMENT_FAILED',
    'VAT_REPORT_GENERATION_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/vat/settlement' },
  mcp: {
    name: 'gnubok_book_vat_settlement',
    title: 'Book VAT Settlement (Momsredovisning)',
    description:
      'Stage the momsredovisning verifikat for a VAT period: 26xx cleared to 2650/1650 at the filed amount, öre gap on 3740, exactly as gnubok_get_vat_settlement_proposal shows. Refused if already booked, empty or locked. Approval books it.',
    keywords: ['bokför moms', 'momsredovisning', 'momsomföring', 'momsavräkning', 'nollställ momskonton', '2650'],
    stage: {
      pendingType: 'book_vat_settlement',
      title: (input) =>
        `Bokför momsredovisning ${formatPeriodLabel(input.period_type as 'monthly' | 'quarterly' | 'yearly', Number(input.year), Number(input.period))}`,
      // The approver saw these lines: the commit must book the same ones.
      pinParams: (input, preview) =>
        typeof preview.fingerprint === 'string' ? { ...input, expected_fingerprint: preview.fingerprint } : input,
    },
  },
  run: async (ctx, input, { dryRun }) => (await settlement()).bookVatSettlement(ctx, input, { dryRun }),
})
