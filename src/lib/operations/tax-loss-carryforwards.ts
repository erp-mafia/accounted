/**
 * The underskottsregister (IL 40 kap.) through the machine doors: read the
 * register, read one year, and save a year (staged over MCP, a person
 * approves). The rules live in lib/bokslut/loss-carryforward; the
 * dashboard's /api/bookkeeping/tax-loss-carryforwards routes call the same
 * functions. Every run refuses while BOLAGET_COMPANY_IDS leaves the company
 * out (LOSS_CARRYFORWARD_UNAVAILABLE), and the operations are discoverable
 * only while the variable opens the register for some company (registry.ts).
 */
import { z } from 'zod'
import {
  getLossCarryforward,
  listLossCarryforwards,
  saveLossCarryforward,
} from '@/lib/bokslut/loss-carryforward/register'
import {
  LOSS_CARRYFORWARD_SOURCES,
  OWNERSHIP_CHANGE_SOURCES,
  SaveLossCarryforwardSchema,
} from '@/lib/bokslut/loss-carryforward/schemas'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const WarningOut = z.object({
  code: z.string().describe('e.g. amount_block_missing_cost, brought_forward_differs, recompute_differs.'),
  message_sv: z.string(),
  message_en: z.string(),
  amount: z.number().optional().describe('The amount the warning names, e.g. what the previous year carries forward.'),
})

const LossYearOut = z.object({
  tax_loss_carryforward_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  fiscal_period: z.object({ name: z.string(), period_start: z.string(), period_end: z.string() }),
  fiscal_year: z.number().int().describe('The calendar year the fiscal year ends in.'),
  brought_forward: z.number().describe('INK2S 4.14 a: the whole deficit brought forward.'),
  source: z.enum(LOSS_CARRYFORWARD_SOURCES),
  result_before_deficit: z.number().nullable().describe('The year\'s result on INK2S before 4.14; negative for a deficit.'),
  group_contributions_received: z.number(),
  amount_block_reduction: z.number().describe('INK2S 4.14 b: cut off for good.'),
  amount_block_manual: z.boolean().describe('True when 4.14 b was stated rather than computed.'),
  group_block_reduction: z.number().describe('INK2S 4.14 c: held back by the koncernbidragsspärr this year.'),
  group_block_manual: z.boolean(),
  deductible: z.number().describe('4.14 a less 4.14 b and 4.14 c: what the year\'s tax adjustments deduct.'),
  taxable_result: z.number().nullable().describe('INK2S 4.15 when positive, 4.16 when negative.'),
  carried_forward: z.number().nullable().describe('To the next year\'s 4.14 a (INK2 1.2: 4.16 plus 4.14 c).'),
  ownership_change: z
    .object({
      date: z.string(),
      source: z.enum(OWNERSHIP_CHANGE_SOURCES),
      amount_block: z.boolean(),
      acquisition_cost: z.number().nullable(),
      capital_contributions: z.number(),
      amount_block_limit: z.number().nullable().describe('300 % of the utgift less tillskott (40:15-16).'),
      group_block: z.boolean(),
      group_block_last_year: z.number().int().nullable(),
    })
    .nullable(),
  group_block_active: z.boolean().describe('Whether a koncernbidragsspärr covers this year.'),
  note: z.string().nullable(),
  document_id: z.string().uuid().nullable(),
  tax_assessment_notice_id: z.string().uuid().nullable(),
  updated_at: z.string().nullable(),
  warnings: z.array(WarningOut),
})

const EXAMPLE_YEAR = {
  tax_loss_carryforward_id: '5d1e…',
  fiscal_period_id: '7c2b…',
  fiscal_period: { name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
  fiscal_year: 2026,
  brought_forward: 1_000_000,
  source: 'tax_assessment',
  result_before_deficit: 100_000,
  group_contributions_received: 0,
  amount_block_reduction: 400_000,
  amount_block_manual: false,
  group_block_reduction: 0,
  group_block_manual: false,
  deductible: 600_000,
  taxable_result: -500_000,
  carried_forward: 500_000,
  ownership_change: {
    date: '2026-06-01',
    source: 'manual',
    amount_block: true,
    acquisition_cost: 250_000,
    capital_contributions: 50_000,
    amount_block_limit: 600_000,
    group_block: false,
    group_block_last_year: null,
  },
  group_block_active: false,
  note: null,
  document_id: null,
  tax_assessment_notice_id: '9a4f…',
  updated_at: '2026-10-29T08:00:00.000Z',
  warnings: [],
}

const DISABLED = 'LOSS_CARRYFORWARD_UNAVAILABLE: the register is not switched on for this company.'
const FORM = 'LOSS_CARRYFORWARD_FORM_UNSUPPORTED: only for companies that file INK2 (aktiebolag, ekonomisk förening).'

export const taxLossCarryforwardsList = defineOperation({
  id: 'tax-loss-carryforwards.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The underskottsregister: prior years\' tax losses per fiscal year (IL 40 kap.), oldest first.',
    description:
      'Each fiscal year with its deficit brought forward (INK2S 4.14 a), the spärrar (4.14 b beloppsspärr and similar, 4.14 c koncernbidragsspärr), the result before the deduction, and the deficit carried forward to the next year. ' +
      'Each year is checked against the one before it; warnings say when 4.14 a differs from what the previous year carries forward, when a spärr could not be computed, or when an earlier year changed. Read-only.',
    useWhen: 'Preparing the tax provision or INK2, or checking how a company\'s tax losses roll forward.',
    doNotUseFor: 'The tax return itself (GET /reports/ink2) or booking anything (the register books nothing).',
    pitfalls: [DISABLED, FORM, 'Amounts are kronor and öre; INK2 takes whole kronor.'],
    example: { response: { data: { tax_loss_carryforwards: [EXAMPLE_YEAR] }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ tax_loss_carryforwards: z.array(LossYearOut) }),
  errorCodes: ['LOSS_CARRYFORWARD_UNAVAILABLE', 'LOSS_CARRYFORWARD_FORM_UNSUPPORTED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/tax-loss-carryforwards' },
  mcp: {
    name: 'gnubok_list_tax_loss_carryforwards',
    title: 'List Tax Loss Carry-forwards',
    description:
      'The underskottsregister (IL 40 kap.): per fiscal year the deficit brought forward (INK2S 4.14 a), spärrar (4.14 b, 4.14 c) and the deficit carried forward, with warnings.',
    visibility: 'search',
    keywords: ['underskott', 'underskottsavdrag', 'outnyttjat underskott', 'underskottsregister', 'beloppsspärr', 'koncernbidragsspärr', '4.14', 'förlust tidigare år'],
  },
  run: async (ctx) => listLossCarryforwards(ctx),
})

export const taxLossCarryforwardsGet = defineOperation({
  id: 'tax-loss-carryforwards.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One fiscal year of the underskottsregister, checked against the year before it.',
    description: 'The same year as the list answers, by its tax_loss_carryforward_id. Read-only.',
    useWhen: 'You hold a tax_loss_carryforward_id and need its figures and warnings.',
    doNotUseFor: 'Finding the year for a fiscal period (list the register instead).',
    pitfalls: [DISABLED, 'LOSS_CARRYFORWARD_NOT_FOUND: the id is not this company\'s.'],
    example: { response: { data: EXAMPLE_YEAR, meta: META } },
  },
  input: z.object({ tax_loss_carryforward_id: z.string().uuid().describe('The year in the register (tax_loss_carryforward_id).') }),
  output: LossYearOut,
  errorCodes: ['LOSS_CARRYFORWARD_UNAVAILABLE', 'LOSS_CARRYFORWARD_FORM_UNSUPPORTED', 'LOSS_CARRYFORWARD_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/tax-loss-carryforwards/:id',
    pathParams: { id: 'tax_loss_carryforward_id' },
  },
  mcp: {
    name: 'gnubok_get_tax_loss_carryforward',
    title: 'Get Tax Loss Carry-forward',
    description: 'One fiscal year of the underskottsregister (IL 40 kap.) by tax_loss_carryforward_id, with its spärrar, carried-forward deficit and warnings.',
    visibility: 'search',
    keywords: ['underskott', 'underskottsregister', 'outnyttjat underskott'],
  },
  run: async (ctx, input) => getLossCarryforward(ctx, input.tax_loss_carryforward_id),
})

function kronor(value: unknown): string {
  return typeof value === 'number' ? new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(value) : '0'
}

export const taxLossCarryforwardsSave = defineOperation({
  id: 'tax-loss-carryforwards.save',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Save one fiscal year of the underskottsregister: the deficit brought forward, an ownership change and the year\'s result.',
    description:
      'Inserts or replaces the year by fiscal_period_id. 4.14 b (beloppsspärr: what exceeds 300 % of the utgift less kapitaltillskott, IL 40 kap. 15-16 §§) and 4.14 c (koncernbidragsspärr: the old deficit capped at the year\'s överskott without koncernbidrag, 40:18) are computed unless stated, and the deficit carried forward follows. ' +
      'The year\'s tax adjustments then prefill 4.14 a from it (4.14 a less 4.14 b and c). Books nothing. Dry-runnable: ?dry_run=true answers what would be stored.',
    useWhen: 'Entering the deficit from the previous year\'s slutskattebesked or INK2, recording an ownership change, or closing a year\'s figures after bokslut.',
    doNotUseFor: 'Booking tax (the year-end dispositions) or filing INK2 (upload the SRU files at skatteverket.se).',
    pitfalls: [
      DISABLED,
      FORM,
      'FISCAL_PERIOD_NOT_FOUND: the fiscal_period_id is not this company\'s.',
      'LOSS_CARRYFORWARD_CHANGE_OUTSIDE_YEAR: the ownership change must be inside the fiscal year it is saved on.',
      'LOSS_CARRYFORWARD_REDUCTIONS_EXCEED: stated 4.14 b and 4.14 c together exceed 4.14 a.',
      'Without acquisition_cost the beloppsspärr is not computed and nothing is cut; the answer warns (amount_block_missing_cost).',
      'Ownership changes are entered by hand; the 40:17 a overriding-reason rule, ackord and konkurs go in as a stated 4.14 b.',
    ],
    example: {
      request: {
        fiscal_period_id: '7c2b…',
        brought_forward: 1_000_000,
        source: 'tax_assessment',
        tax_assessment_notice_id: '9a4f…',
        result_before_deficit: 100_000,
        ownership_change: { date: '2026-06-01', amount_block: true, acquisition_cost: 250_000, capital_contributions: 50_000, group_block: false },
      },
      response: { data: EXAMPLE_YEAR, meta: META },
    },
  },
  input: SaveLossCarryforwardSchema,
  output: LossYearOut,
  errorCodes: [
    'LOSS_CARRYFORWARD_UNAVAILABLE',
    'LOSS_CARRYFORWARD_FORM_UNSUPPORTED',
    'FISCAL_PERIOD_NOT_FOUND',
    'LOSS_CARRYFORWARD_LINK_NOT_FOUND',
    'LOSS_CARRYFORWARD_CHANGE_OUTSIDE_YEAR',
    'LOSS_CARRYFORWARD_BLOCK_END_BEFORE_CHANGE',
    'LOSS_CARRYFORWARD_REDUCTIONS_EXCEED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/tax-loss-carryforwards' },
  mcp: {
    name: 'gnubok_save_tax_loss_carryforward',
    title: 'Save Tax Loss Carry-forward',
    description:
      'Stage saving a fiscal year of the underskottsregister (IL 40 kap.): deficit brought forward (4.14 a), an ownership change behind a spärr, the year\'s result. Spärrar and carried-forward deficit are computed. Books nothing.',
    visibility: 'search',
    keywords: ['underskott', 'spara underskott', 'outnyttjat underskott', 'underskottsregister', 'ägarförändring', 'beloppsspärr', 'koncernbidragsspärr', 'slutskattebesked underskott'],
    stage: {
      pendingType: 'save_tax_loss_carryforward',
      title: (input, preview) => {
        const name = (preview?.fiscal_period as { name?: string } | undefined)?.name ?? 'räkenskapsåret'
        return `Underskottsregistret ${name}: ${kronor(input.brought_forward)} kr från föregående år`
      },
      preview: (_input, preview) => ({
        fiscal_year: preview.fiscal_year,
        deficit_brought_forward_amount: preview.brought_forward,
        deficit_amount_block_amount: preview.amount_block_reduction,
        deficit_group_block_amount: preview.group_block_reduction,
        deficit_deductible_amount: preview.deductible,
        deficit_carried_forward_amount: preview.carried_forward,
        warnings: Array.isArray(preview.warnings)
          ? (preview.warnings as Array<{ message_sv?: string }>).map((w) => w.message_sv ?? '').filter(Boolean)
          : [],
      }),
    },
  },
  run: (ctx, input, { dryRun }) => saveLossCarryforward(ctx, input, { dryRun }),
})

export const TAX_LOSS_CARRYFORWARD_OPERATIONS = [
  taxLossCarryforwardsList,
  taxLossCarryforwardsGet,
  taxLossCarryforwardsSave,
] as const
