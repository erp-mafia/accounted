/**
 * Defined measures (lib/measures) over v1 REST and MCP, from one definition:
 *
 *   GET /measures              measures.list     gnubok_list_measures
 *   GET /measures/{id}         measures.get      gnubok_get_measure
 *   GET /measures/{id}/explain measures.explain  gnubok_explain_measure
 *
 * Read-only. The MCP tools are search-only (no tools/list cost): the agent
 * briefing points at them, and gnubok_call_tool reaches them from a client
 * that only knows tools/list. Each value equals a report a person sees
 * (`equals` names it); a figure that cannot be computed answers a MEASURE_*
 * refusal with a Swedish sentence, never a zero.
 */
import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

// Loaded on first use: the measures read the report generators (VAT,
// ledgers, trial balance), a graph the registry's other importers (the MCP
// server, the commit path) do not need.
const measures = () => import('@/lib/measures')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

/** The receivables account in the documented example: the SE pack's, as a Swedish company answers it. */
const EXAMPLE_RECEIVABLES_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_receivable')

/** Kept in step with lib/measures MEASURE_IDS by __tests__ in lib/measures. */
export const MEASURE_ID_LIST =
  'vat_payable, accounts_receivable, accounts_payable, bank_balance, liquid_funds, result_to_date, net_revenue, operating_expenses, unpaid_customer_invoices, unpaid_supplier_invoices'

const MEASURE_ID = z
  .string()
  .min(1)
  .describe(`The measure: ${MEASURE_ID_LIST}. Definitions: gnubok_list_measures / GET /measures.`)

const PARAM_FIELDS = {
  period_id: z
    .string()
    .uuid()
    .optional()
    .describe('Period measures: the fiscal period (default: the one containing today). vat_payable: yearly only, a broken räkenskapsår.'),
  from_date: isoDateSchema.optional().describe('Period measures: range start inside the fiscal period.'),
  to_date: isoDateSchema.optional().describe('Period measures: range end inside the fiscal period.'),
  as_of_date: isoDateSchema.optional().describe('Balance and register measures: the balance date (default today).'),
  period_type: z.enum(['monthly', 'quarterly', 'yearly']).optional().describe('vat_payable: the momsperiod length.'),
  year: z.coerce.number().int().min(2000).max(2100).optional().describe('vat_payable: year of the momsperiod.'),
  period: z.coerce.number().int().min(1).max(12).optional().describe('vat_payable: 1-12 monthly, 1-4 quarterly, 1 yearly.'),
}

type MeasureInput = {
  measure_id: string
  period_id?: string
  from_date?: string
  to_date?: string
  as_of_date?: string
  period_type?: 'monthly' | 'quarterly' | 'yearly'
  year?: number
  period?: number
}

/** The measure parameters the caller sent, without the id and the paging. */
function paramsOf(input: MeasureInput) {
  return {
    ...(input.period_id !== undefined ? { period_id: input.period_id } : {}),
    ...(input.from_date !== undefined ? { from_date: input.from_date } : {}),
    ...(input.to_date !== undefined ? { to_date: input.to_date } : {}),
    ...(input.as_of_date !== undefined ? { as_of_date: input.as_of_date } : {}),
    ...(input.period_type !== undefined ? { period_type: input.period_type } : {}),
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.period !== undefined ? { period: input.period } : {}),
  }
}

function measureCtx(ctx: OperationContext) {
  return { supabase: ctx.supabase, companyId: ctx.companyId }
}

/**
 * The registry's outcome in the operation contract. The registry returns
 * interfaces; the output schemas below document them for OpenAPI and the MCP
 * outputSchema (neither door re-validates the payload), so the data is
 * re-typed here, unchanged.
 */
function toOutcome<O>(
  outcome: { ok: true; data: unknown } | { ok: false; code: string; messageSv: string; details: Record<string, unknown> },
): OperationOutcome<O> {
  return outcome.ok
    ? { ok: true, data: outcome.data as O }
    : { ok: false, code: outcome.code, messageSv: outcome.messageSv, details: outcome.details }
}

const Equals = z.object({
  report: z.string().describe('The report the measure equals, as the product names it.'),
  figure: z.string().describe('The figure of that report the value equals.'),
  v1_path: z.string().describe('The report endpoint, relative to /api/v1/companies/{companyId}.'),
  mcp_tool: z.string().describe('The MCP tool that answers the same report.'),
})

const Period = z.object({
  start: z.string(),
  end: z.string(),
  fiscal_period_id: z.string().nullable(),
})

const Caveat = z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() })

const MeasureSummaryOut = z.object({
  measure_id: z.string(),
  name_sv: z.string(),
  name_en: z.string(),
  definition: z.string(),
  definition_sv: z.string(),
  unit: z.literal('SEK'),
  dimension: z.enum(['period', 'as_of', 'vat_period']),
  parameters: z.array(z.string()).describe('The parameters this measure takes; any other is refused.'),
  equals: Equals,
})

const ExplainHandle = z
  .object({
    tool: z.literal('gnubok_explain_measure'),
    arguments: z.record(z.string(), z.unknown()).describe('Pass as the arguments of gnubok_explain_measure: they pin this exact figure.'),
    v1_path: z.string().describe('The same explanation over REST.'),
  })
  .describe('The call that explains this figure: contributors and the journal lines or invoices behind it.')

const MeasureValueOut = z.object({
  measure_id: z.string(),
  name_sv: z.string(),
  name_en: z.string(),
  definition: z.string(),
  unit: z.literal('SEK'),
  value: z.number().describe('The figure, in SEK. vat_payable: positive = to pay, negative = to get back.'),
  count: z.number().int().nullable().describe('Invoice measures: the number of open invoices. Null otherwise.'),
  as_of: z.string().describe('The date the value holds at: the balance date or the range end.'),
  period: Period.describe('The range the value covers.'),
  vat_period: z.object({ period_type: z.string(), year: z.number(), period: z.number() }).nullable(),
  equals: Equals,
  caveats: z.array(Caveat).describe('Why the figure may not be the whole truth; empty when nothing qualifies it. Tell the user.'),
  data_status: z.unknown().nullable().describe('The report trust signals over the same range (unbooked rows, drafts, bank feed); null for register measures.'),
  explain: ExplainHandle,
})

const Contributor = z.object({
  kind: z.enum(['account', 'customer', 'supplier']),
  account_number: z.string().optional(),
  customer_id: z.string().optional(),
  supplier_id: z.string().optional(),
  handle: z.string().optional().describe('Typed handle of the customer (cus_) or supplier (sup_).'),
  name: z.string(),
  amount: z.number().describe('Signed contribution to the value.'),
  ruta: z.string().optional().describe('vat_payable: the ruta the account lands in.'),
  role: z.string().optional().describe('The account role the account answers (accounts_receivable, bank, ...).'),
  cash_account_id: z.string().optional(),
  opening_balance: z.number().optional().describe('Balance measures: the part carried in at the fiscal year start.'),
})

const DrilldownItem = z
  .object({
    journal_entry_id: z.string().optional(),
    invoice_id: z.string().optional(),
    supplier_invoice_id: z.string().optional(),
    handle: z.string().nullable().describe('Typed handle of the record (je_, inv_, sinv_): accepted wherever its id is.'),
  })
  .passthrough()

const MeasureExplanationOut = z.object({
  measure_id: z.string(),
  name_sv: z.string(),
  unit: z.literal('SEK'),
  value: z.number(),
  count: z.number().int().nullable(),
  as_of: z.string(),
  period: Period,
  equals: Equals,
  contributors: z.array(Contributor).describe('What the value adds, complete: accounts, or customers/suppliers for the invoice measures.'),
  drilldown: z.object({
    kind: z.enum(['journal_lines', 'invoices', 'supplier_invoices']),
    items: z.array(DrilldownItem),
    total: z.number().int(),
    offset: z.number().int(),
    next_offset: z.number().int().nullable().describe('Pass as offset for the next page; null on the last page.'),
  }),
  reconciles: z.boolean().describe('True when contributors add up to the value and each to its drill-down. False names the gap in reconciliation_note.'),
  reconciliation_note: z.string().nullable(),
})

const EXAMPLE_VALUE = {
  measure_id: 'vat_payable',
  name_sv: 'Moms att betala eller få tillbaka',
  name_en: 'VAT payable or refundable',
  definition: 'Ruta 49 of the momsdeklaration (SKV 4700) for one momsperiod: ...',
  unit: 'SEK',
  value: 18750,
  count: null,
  as_of: '2026-09-30',
  period: { start: '2026-07-01', end: '2026-09-30', fiscal_period_id: '7c2b…' },
  vat_period: { period_type: 'quarterly', year: 2026, period: 3 },
  equals: { report: 'Momsdeklaration (SKV 4700)', figure: 'rutor.ruta49, same period_type/year/period', v1_path: '/reports/vat-declaration', mcp_tool: 'gnubok_get_vat_report' },
  caveats: [],
  data_status: null,
  explain: {
    tool: 'gnubok_explain_measure',
    arguments: { measure_id: 'vat_payable', period_type: 'quarterly', year: 2026, period: 3 },
    v1_path: '/api/v1/companies/9f1e…/measures/vat_payable/explain?period_type=quarterly&year=2026&period=3',
  },
}

export const measuresList = defineOperation({
  id: 'measures.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The defined measures: id, name, precise definition, parameters and the report each equals.',
    description:
      'Lists every defined measure (moms att betala, kundfordringar, leverantörsskulder, banksaldo, likvida medel, resultat hittills i år, omsättning, kostnader, obetalda kund- och leverantörsfakturor) with its Swedish and English name, a precise definition, the dimension it is measured over (period, as_of or vat_period), the parameters it takes and the report it equals. Static: no company data is read.',
    useWhen: 'Before GET /measures/{id}, to pick the measure that answers a question and see which parameters it takes.',
    doNotUseFor: 'The values themselves (GET /measures/{id}).',
    pitfalls: ['Measure ids are stable; new measures may be added, so treat an unknown id in this list as valid.'],
    example: {
      response: {
        data: {
          measures: [
            {
              measure_id: 'accounts_receivable',
              name_sv: 'Kundfordringar',
              name_en: 'Accounts receivable',
              definition: 'Booked balance (debit minus credit) of the receivables control account ...',
              definition_sv: 'Bokfört saldo (debet minus kredit) på kundfordringskontot ...',
              unit: 'SEK',
              dimension: 'as_of',
              parameters: ['as_of_date'],
              equals: { report: 'Balansräkning', figure: '...', v1_path: '/reports/balance-sheet', mcp_tool: 'gnubok_get_balance_sheet' },
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({}).strict(),
  output: z.object({ measures: z.array(MeasureSummaryOut) }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/measures' },
  mcp: {
    name: 'gnubok_list_measures',
    title: 'List Measures',
    description:
      'List the defined measures: id, Swedish/English name, precise definition, parameters and the report each equals. Use to pick the measure for gnubok_get_measure.',
    keywords: ['mått', 'definition', 'nyckeltal'],
  },
  run: async () => {
    const { listMeasures } = await measures()
    return { ok: true, data: { measures: listMeasures() } }
  },
})

export const measuresGet = defineOperation({
  id: 'measures.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One defined measure: the value, its definition, what it covers, caveats and an explain handle.',
    description:
      'Answers one defined figure, computed by the report a person sees (equals names the report and figure; the value is always that figure), with its definition, the date it holds at, the range it covers, caveats that qualify it and the report trust signals (data_status). explain is the call that lists what this exact figure adds. A figure that cannot be computed answers a MEASURE_* error with a Swedish message: a missing momsperiod, no fiscal period for the date, a parameter the measure does not take, an account role the company\'s country has no account for, or a report that could not be read. Never a zero in place of an answer.',
    useWhen: 'An agent or dashboard needs one figure (moms att betala, kundfordringar, banksaldo, resultat ...) defined once and equal to the report, instead of rebuilding it from reports or journal lines.',
    doNotUseFor: 'The full report (GET /reports/...), or a figure that is not in the list (GET /measures).',
    pitfalls: [
      'Period measures take period_id/from_date/to_date, balance and register measures as_of_date, vat_payable period_type/year/period. Any other parameter is refused with MEASURE_PARAMETER_NOT_ACCEPTED, never ignored.',
      'vat_payable has no default period: without period_type, year and period it answers MEASURE_PERIOD_REQUIRED.',
      'accounts_receivable is the booked balance; unpaid_customer_invoices is the invoice register. They differ when invoices exist only as journal entries (a caveat says so).',
      'Read caveats and data_status before presenting a figure as final.',
    ],
    example: { request: { period_type: 'quarterly', year: 2026, period: 3 }, response: { data: EXAMPLE_VALUE, meta: META } },
  },
  // Strict: a parameter the endpoint does not know is refused, never dropped
  // (a dropped as_of would answer today's figure to a question about another day).
  input: z.object({ measure_id: MEASURE_ID, ...PARAM_FIELDS }).strict(),
  output: MeasureValueOut,
  errorCodes: [
    'MEASURE_NOT_FOUND',
    'MEASURE_PARAMETER_NOT_ACCEPTED',
    'MEASURE_PERIOD_REQUIRED',
    'MEASURE_PERIOD_NOT_FOUND',
    'MEASURE_RANGE_INVALID',
    'MEASURE_ACCOUNT_ROLE_UNAVAILABLE',
    'MEASURE_SOURCE_FAILED',
  ],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/measures/:measureId',
    pathParams: { measureId: 'measure_id' },
  },
  mcp: {
    name: 'gnubok_get_measure',
    title: 'Get Measure',
    description:
      'One defined figure (moms att betala, kundfordringar, leverantörsskulder, banksaldo, likvida medel, resultat, omsättning, kostnader, obetalda fakturor), equal to its report, with definition, as_of, caveats and an explain handle. Prefer over computing.',
    keywords: ['mått', 'banksaldo', 'likvida medel', 'kundfordringar', 'leverantörsskulder', 'omsättning'],
  },
  run: async (ctx, input) => {
    const { getMeasure } = await measures()
    return toOutcome<z.infer<typeof MeasureValueOut>>(await getMeasure(measureCtx(ctx), input.measure_id, paramsOf(input)))
  },
})

export const measuresExplain = defineOperation({
  id: 'measures.explain',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'What a defined measure adds: contributors and the journal lines or invoices behind it, paged.',
    description:
      'Explains one measure value: the same value as GET /measures/{id}, the complete list of what it adds (accounts with their amount and opening balance, the ruta of each VAT account, or the customers and suppliers of an invoice measure) and, paged, the journal lines or open invoices behind them, each with its typed handle (je_, inv_, sinv_). reconciles says whether contributors add up to the value and each to its drill-down; reconciliation_note names any gap. Send the explain.arguments a GET /measures/{id} answered to explain that exact figure.',
    useWhen: 'An agent must show why a figure is what it is, or find the vouchers or invoices behind it.',
    doNotUseFor: 'The value alone (GET /measures/{id} is lighter).',
    pitfalls: [
      'drilldown is paged: limit (1-500, default 50) and offset; next_offset is null on the last page.',
      'Takes the same parameters as GET /measures/{id}; a default (today, the current fiscal year) is resolved again on every call, so pass the explain handle\'s pinned arguments.',
    ],
    example: {
      request: { as_of_date: '2026-10-16' },
      response: {
        data: {
          measure_id: 'accounts_receivable',
          name_sv: 'Kundfordringar',
          unit: 'SEK',
          value: 45000,
          count: null,
          as_of: '2026-10-16',
          period: { start: '2026-01-01', end: '2026-10-16', fiscal_period_id: '7c2b…' },
          equals: { report: 'Balansräkning', figure: '...', v1_path: '/reports/balance-sheet', mcp_tool: 'gnubok_get_balance_sheet' },
          contributors: [{ kind: 'account', account_number: EXAMPLE_RECEIVABLES_ACCOUNT, name: 'Kundfordringar', amount: 45000, opening_balance: 12000, role: 'accounts_receivable' }],
          drilldown: {
            kind: 'journal_lines',
            items: [{ journal_entry_id: '0e9c41d2-…', handle: 'je_0e9c41d2…', voucher_series: 'A', voucher_number: 12, date: '2026-03-02', account_number: EXAMPLE_RECEIVABLES_ACCOUNT, description: 'Faktura 1004', debit: 33000, credit: 0 }],
            total: 1,
            offset: 0,
            next_offset: null,
          },
          reconciles: true,
          reconciliation_note: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    measure_id: MEASURE_ID,
    ...PARAM_FIELDS,
    limit: z.coerce.number().int().min(1).max(500).optional().describe('Drill-down page size, 1-500 (default 50).'),
    offset: z.coerce.number().int().min(0).optional().describe('Drill-down rows to skip (next_offset of the previous page).'),
  }).strict(),
  output: MeasureExplanationOut,
  errorCodes: [
    'MEASURE_NOT_FOUND',
    'MEASURE_PARAMETER_NOT_ACCEPTED',
    'MEASURE_PERIOD_REQUIRED',
    'MEASURE_PERIOD_NOT_FOUND',
    'MEASURE_RANGE_INVALID',
    'MEASURE_ACCOUNT_ROLE_UNAVAILABLE',
    'MEASURE_SOURCE_FAILED',
  ],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/measures/:measureId/explain',
    pathParams: { measureId: 'measure_id' },
  },
  mcp: {
    name: 'gnubok_explain_measure',
    title: 'Explain Measure',
    description:
      'Explain a gnubok_get_measure figure: the accounts, customers or suppliers it adds and the journal lines or invoices behind it (typed handles, paged by limit/offset), with a tie-out flag. Pass the explain handle\'s arguments.',
    keywords: ['förklara', 'mått', 'verifikat'],
  },
  run: async (ctx, input) => {
    const { explainMeasure } = await measures()
    return toOutcome<z.infer<typeof MeasureExplanationOut>>(
      await explainMeasure(measureCtx(ctx), input.measure_id, paramsOf(input), {
        limit: input.limit,
        offset: input.offset,
      }),
    )
  },
})

export const MEASURE_OPERATIONS = [measuresList, measuresGet, measuresExplain] as const
