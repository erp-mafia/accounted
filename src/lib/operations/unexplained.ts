/**
 * The unexplained queue (lib/unexplained) over v1 REST and MCP, from one
 * definition:
 *
 *   GET /unexplained                    unexplained.list     gnubok_list_unexplained
 *   GET /unexplained/{checkId}          unexplained.get      gnubok_get_unexplained
 *   GET /unexplained/{checkId}/explain  unexplained.explain  gnubok_explain_unexplained
 *
 * Read-only. The MCP tools are search-only (no tools/list cost): the agent
 * briefing carries the count and the top rows and names the list tool, and
 * gnubok_call_tool reaches them from a client that only knows tools/list.
 * A check that cannot run answers cannot_check with a typed reason inside
 * the data, never an error and never ok; the doors refuse only an unknown
 * check or a subject that does not exist.
 */
import { z } from 'zod'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

// Loaded on first use: the checks read the report generators, the
// reconciliation engines and the VAT filings, a graph the registry's other
// importers (the MCP server, the commit path) do not need.
const unexplained = () => import('@/lib/unexplained')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

/** Kept in step with lib/unexplained CHECK_IDS by __tests__ in lib/unexplained. */
export const CHECK_ID_LIST =
  'receivables_vs_ledger, payables_vs_ledger, bank_balance_vs_bank, skattekonto_vs_skatteverket, vat_declared_not_settled, unbooked_bank_lines_overdue'

const CHECK_ID = z
  .string()
  .min(1)
  .describe(`The check: ${CHECK_ID_LIST}. The queue (GET /unexplained, gnubok_list_unexplained) lists every result.`)

const ERROR_CODES = [
  'UNEXPLAINED_CHECK_NOT_FOUND',
  'UNEXPLAINED_PARAMETER_NOT_ACCEPTED',
  'UNEXPLAINED_SUBJECT_REQUIRED',
  'UNEXPLAINED_SUBJECT_NOT_FOUND',
]

function checkCtx(ctx: OperationContext) {
  return { supabase: ctx.supabase, companyId: ctx.companyId }
}

/**
 * The registry's outcome in the operation contract. The output schemas below
 * document the registry's interfaces for OpenAPI and the MCP outputSchema
 * (neither door re-validates the payload), so the data is re-typed, unchanged.
 */
function toOutcome<O>(
  outcome: { ok: true; data: unknown } | { ok: false; code: string; messageSv: string; details: Record<string, unknown> },
): OperationOutcome<O> {
  return outcome.ok
    ? { ok: true, data: outcome.data as O }
    : { ok: false, code: outcome.code, messageSv: outcome.messageSv, details: outcome.details }
}

const Status = z
  .enum(['ok', 'unexplained', 'cannot_check'])
  .describe('ok: within the tolerance. unexplained: a difference to resolve. cannot_check: not run, refusal says why; never read it as ok.')

const Unit = z.enum(['SEK', 'count']).describe('SEK for money differences; count for unbooked_bank_lines_overdue.')

const Subject = z
  .object({
    kind: z.enum(['company', 'bank_account', 'vat_period']),
    cash_account_id: z.string().optional(),
    handle: z.string().nullable().optional().describe('bank_account: typed handle of the cash account (cash_).'),
    account_number: z.string().optional(),
    name: z.string().optional(),
    period_type: z.string().optional(),
    year: z.number().optional(),
    period: z.number().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    label: z.string().optional(),
  })
  .describe('What the result is about: the company, one bank account, or one momsperiod.')

const Source = z.object({
  report: z.string().describe('The report or register, as the product names it.'),
  v1_path: z.string().nullable().describe('Relative to /api/v1/companies/{companyId}.'),
  mcp_tool: z.string(),
  screen: z.string().nullable().describe('The screen in the app.'),
})

const Side = z.object({
  key: z.string(),
  label_sv: z.string(),
  label_en: z.string(),
  amount: z.number().nullable(),
  source: Source,
})

const Refusal = z
  .object({
    code: z.string().describe('CASH_METHOD, NO_FISCAL_PERIOD, ACCOUNT_ROLE_UNAVAILABLE, FX_RATE_MISSING, NO_BANK_BALANCE, FOREIGN_CURRENCY_ACCOUNT, SHARED_LEDGER_ACCOUNT, SKATTEKONTO_NOT_CONNECTED, NO_SKATTEVERKET_BALANCE, NOT_VAT_REGISTERED, NO_DECLARED_PERIODS or SOURCE_FAILED.'),
    message_sv: z.string(),
    message_en: z.string(),
    retryable: z.boolean().optional().describe('SOURCE_FAILED: true when a retry may help.'),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .describe('Why the check could not run.')

const NextAction = z
  .object({
    message_sv: z.string(),
    tool: z.string().describe('The MCP tool that resolves this kind of difference.'),
    arguments: z.record(z.string(), z.unknown()).optional(),
    screen: z.string(),
  })
  .describe('What fixes it.')

const ExplainHandle = z
  .object({
    tool: z.literal('gnubok_explain_unexplained'),
    arguments: z.record(z.string(), z.unknown()).describe('Pass as the arguments of gnubok_explain_unexplained.'),
    v1_path: z.string().describe('The same explanation over REST.'),
  })
  .describe('The call that names the items behind this result.')

const Row = z.object({
  check_id: z.string(),
  name_sv: z.string(),
  status: Status,
  subject: Subject,
  difference: z.number().nullable().describe('Signed, in unit; null when the check could not run.'),
  unit: Unit,
  as_of: z.string().describe('The date the comparison holds at.'),
  summary_sv: z.string().describe('One Swedish sentence: the finding, or the reason it could not be checked.'),
  refusal_code: z.string().nullable(),
  next: z
    .object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), screen: z.string() })
    .nullable()
    .describe('unexplained only: the tool or screen that fixes it.'),
  explain: ExplainHandle,
})

const ListOut = z.object({
  as_of: z.string(),
  counts: z.object({ unexplained: z.number().int(), cannot_check: z.number().int(), ok: z.number().int() }),
  items: z.array(Row).describe('Unexplained first (largest SEK difference first), then cannot_check, then ok.'),
  truncated: z.number().int().describe('Rows left out after the first 30 (ok rows are the last).'),
})

const CheckOut = z.object({
  check_id: z.string(),
  name_sv: z.string(),
  name_en: z.string(),
  definition: z.string().describe('Which figure minus which, read how, and what zero means.'),
  definition_sv: z.string(),
  basis: z.string().describe('The rule it rests on: why the difference should be zero.'),
  unit: Unit,
  tolerance: z.number().describe('The largest difference that is still ok, in unit.'),
  subject_kind: z.enum(['company', 'bank_account', 'vat_period']),
  compares: z.array(Source).describe('The figures compared, in the order of the subtraction.'),
  next_action: NextAction,
  status: Status.describe('Worst of the results: unexplained, then cannot_check; ok only when every result is ok.'),
  results: z.array(
    z.object({
      status: Status,
      subject: Subject,
      difference: z.number().nullable(),
      as_of: z.string(),
      summary_sv: z.string(),
      sides: z.array(Side).describe('The two figures, each with the report where a person reads it.'),
      refusal: Refusal.nullable(),
      facts: z.record(z.string(), z.unknown()).nullable(),
      next_action: NextAction.nullable(),
      explain: ExplainHandle,
    }),
  ),
})

const Item = z
  .object({
    part: z.string().describe('The part (see parts) the item belongs to.'),
    item_type: z.enum(['invoice', 'supplier_invoice', 'journal_line', 'transaction', 'skattekonto_transaction', 'vat_account']),
    invoice_id: z.string().optional(),
    supplier_invoice_id: z.string().optional(),
    journal_entry_id: z.string().optional(),
    transaction_id: z.string().optional(),
    skattekonto_transaction_id: z.string().optional(),
    account_number: z.string().optional(),
    handle: z.string().nullable().describe('Typed handle (inv_, sinv_, je_, txn_), accepted wherever the id is.'),
    date: z.string().nullable(),
    label: z.string(),
    amount: z.number().describe('Signed contribution to the difference, in unit.'),
    currency: z.string().optional(),
    record_amount: z.number().optional().describe('Count checks: the record\'s own amount in currency.'),
    days_past_deadline: z.number().int().optional(),
  })
  .passthrough()

const ExplainOut = z.object({
  check_id: z.string(),
  name_sv: z.string(),
  status: Status,
  subject: Subject,
  difference: z.number().nullable(),
  unit: Unit,
  as_of: z.string(),
  summary_sv: z.string(),
  sides: z.array(Side),
  refusal: Refusal.nullable(),
  parts: z
    .array(z.object({ key: z.string(), label_sv: z.string(), label_en: z.string(), amount: z.number(), count: z.number().int() }))
    .describe('The difference broken into parts, each with its items.'),
  residual: z.number().nullable().describe('Difference minus the parts: what the items do not name.'),
  reconciles: z.boolean().describe('True when the parts account for the difference within the tolerance.'),
  note: z.string().nullable().describe('What else bears on it, in English.'),
  items: z.object({
    list: z.array(Item),
    total: z.number().int(),
    offset: z.number().int(),
    next_offset: z.number().int().nullable().describe('Pass as offset for the next page; null on the last page.'),
  }),
  next_action: NextAction.nullable(),
})

const EXAMPLE_ROW = {
  check_id: 'receivables_vs_ledger',
  name_sv: 'Kundreskontran mot bokförda kundfordringar',
  status: 'unexplained',
  subject: { kind: 'company' },
  difference: 3000,
  unit: 'SEK',
  as_of: '2026-10-16',
  summary_sv: 'Kundreskontran visar 15 500,00 kr men de bokförda kundfordringarna är 12 500,00 kr: differens 3 000,00 kr.',
  refusal_code: null,
  next: { tool: 'gnubok_link_invoice_to_voucher', screen: '/reports/kundreskontra' },
  explain: {
    tool: 'gnubok_explain_unexplained',
    arguments: { check_id: 'receivables_vs_ledger' },
    v1_path: '/api/v1/companies/9f1e…/unexplained/receivables_vs_ledger/explain',
  },
}

export const unexplainedList = defineOperation({
  id: 'unexplained.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The unexplained queue: every expected-zero check run for the company, differences first.',
    description:
      'Runs every check of a difference that should be zero and lists one row per result: kundreskontra against booked receivables, leverantörsreskontra against booked payables, each bank account\'s booked balance against the balance the bank reported, the skattekonto account against Skatteverket\'s saldo, declared momsperioder whose VAT accounts were never moved to the settlement account, and bank transactions still unbooked past the BFNAR 2013:2 booking deadline. Each row has its status (ok, unexplained, cannot_check with a typed reason), the signed difference, the date it holds at, one Swedish sentence, what fixes it, and the explain call that names the items behind it. Both figures of every check come from the report a person sees. Read-only.',
    useWhen: 'At the start of a session or before a close: what in the books does not add up, and what to do about it.',
    doNotUseFor: 'A single figure (GET /measures/{id}) or the full reconciliation of one account (GET /reconciliation/accounts/{accountKey}).',
    pitfalls: [
      'cannot_check is not ok: the check could not run (refusal_code says why: kontantmetoden, no bank balance, not connected to Skatteverket, ...).',
      'Live: every check reads today\'s state. The bank and skattekonto rows compare on the date the outside balance was fetched (as_of).',
      'difference is in unit: SEK, or a count for unbooked_bank_lines_overdue.',
    ],
    example: {
      response: {
        data: { as_of: '2026-10-16', counts: { unexplained: 1, cannot_check: 2, ok: 4 }, items: [EXAMPLE_ROW], truncated: 0 },
        meta: META,
      },
    },
  },
  input: z.object({}).strict(),
  output: ListOut,
  http: { method: 'GET', path: '/api/v1/companies/:companyId/unexplained' },
  mcp: {
    name: 'gnubok_list_unexplained',
    title: 'List Unexplained Differences',
    description:
      'The unexplained queue: expected-zero checks (reskontra vs 1510/2440, bank vs books, skattekonto vs Skatteverket, declared moms not settled, overdue unbooked bank rows), each ok, unexplained or cannot_check, with difference, fix and explain call.',
    keywords: ['avstämning', 'differens', 'stämmer inte', 'oförklarad', 'kontroll', 'avvikelse'],
  },
  run: async (ctx) => {
    const { listUnexplained } = await unexplained()
    return toOutcome<z.infer<typeof ListOut>>({ ok: true, data: await listUnexplained(checkCtx(ctx)) })
  },
})

export const unexplainedGet = defineOperation({
  id: 'unexplained.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One expected-zero check: its definition and basis, the figures it compares, and every result.',
    description:
      'Runs one check and answers its definition (which figure minus which, read how), the rule it rests on, the tolerance, the reports the two figures come from, the action that fixes a difference, and one result per subject (the company, each bank account, each declared momsperiod) with both figures, the difference, a Swedish sentence, any refusal and the explain call.',
    useWhen: 'An agent must say exactly what a queue row compares, or show both figures with where a person reads them.',
    doNotUseFor: 'The items behind a difference (GET /unexplained/{checkId}/explain).',
    pitfalls: ['An unknown check_id answers 404 UNEXPLAINED_CHECK_NOT_FOUND with the valid ids in details.valid.'],
    example: {
      request: { check_id: 'receivables_vs_ledger' },
      response: {
        data: {
          check_id: 'receivables_vs_ledger',
          name_sv: 'Kundreskontran mot bokförda kundfordringar',
          name_en: 'Customer ledger against booked receivables',
          definition: 'Open customer invoices in the invoice register now ... minus the booked balance of the receivables accounts ...',
          definition_sv: 'Öppna kundfakturor i fakturaregistret just nu ... minus bokfört saldo på kundfordringskontona ...',
          basis: 'Every balance sheet account is reconciled against its underlag ...',
          unit: 'SEK',
          tolerance: 0.005,
          subject_kind: 'company',
          compares: [
            { report: 'Kundreskontra (öppna kundfakturor)', v1_path: '/reports/ar-ledger', mcp_tool: 'gnubok_get_ar_ledger', screen: '/reports/kundreskontra' },
            { report: 'Huvudbok, kundfordringskontona', v1_path: '/reports/general-ledger', mcp_tool: 'gnubok_get_general_ledger', screen: '/reports/huvudbok' },
          ],
          next_action: { message_sv: 'Öppna förklaringen ...', tool: 'gnubok_link_invoice_to_voucher', screen: '/reports/kundreskontra' },
          status: 'unexplained',
          results: [
            {
              status: 'unexplained',
              subject: { kind: 'company' },
              difference: 3000,
              as_of: '2026-10-16',
              summary_sv: EXAMPLE_ROW.summary_sv,
              sides: [
                { key: 'register', label_sv: 'Öppna kundfakturor i reskontran', label_en: 'Open customer invoices in the register', amount: 15500, source: { report: 'Kundreskontra (öppna kundfakturor)', v1_path: '/reports/ar-ledger', mcp_tool: 'gnubok_get_ar_ledger', screen: '/reports/kundreskontra' } },
                { key: 'ledger', label_sv: 'Bokförda kundfordringar', label_en: 'Booked receivables', amount: 12500, source: { report: 'Huvudbok, kundfordringskontona', v1_path: '/reports/general-ledger', mcp_tool: 'gnubok_get_general_ledger', screen: '/reports/huvudbok' } },
              ],
              refusal: null,
              facts: { fiscal_period_id: '7c2b…' },
              next_action: { message_sv: 'Öppna förklaringen ...', tool: 'gnubok_link_invoice_to_voucher', screen: '/reports/kundreskontra' },
              explain: EXAMPLE_ROW.explain,
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({ check_id: CHECK_ID }).strict(),
  output: CheckOut,
  errorCodes: ['UNEXPLAINED_CHECK_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/unexplained/:checkId',
    pathParams: { checkId: 'check_id' },
  },
  mcp: {
    name: 'gnubok_get_unexplained',
    title: 'Get Unexplained Check',
    description:
      'One expected-zero check from gnubok_list_unexplained: definition, the rule it rests on, both figures per result with the report each is read from, the difference and the fix. Use to say exactly what a queue row compares.',
    keywords: ['avstämning', 'differens', 'definition'],
  },
  run: async (ctx, input) => {
    const { getUnexplainedCheck } = await unexplained()
    return toOutcome<z.infer<typeof CheckOut>>(await getUnexplainedCheck(checkCtx(ctx), input.check_id))
  },
})

export const unexplainedExplain = defineOperation({
  id: 'unexplained.explain',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'What a difference in the queue consists of: its parts and the items behind them, with typed handles.',
    description:
      'Explains one result of a check: the same difference as the queue, broken into parts (open invoices without a verifikat and verifikat on the control account without an invoice; unbooked bank transactions; Skatteverket events missing from the books and verifikat Skatteverket does not know; the VAT accounts not yet cleared; the overdue bank rows) and, paged, the items behind each part with their typed handles (inv_, sinv_, je_, txn_). residual is what the items do not name and note says what it usually is. For a check with several results (bank accounts, momsperioder), send the subject: cash_account_id, or period_type, year and period, as the explain handle of the row gives them.',
    useWhen: 'An agent must show why a queue row is not zero, or find the records to fix.',
    doNotUseFor: 'The queue itself (GET /unexplained).',
    pitfalls: [
      'items is paged: limit (1-200, default 25) and offset; next_offset is null on the last page.',
      'A check with several results and no subject answers 400 UNEXPLAINED_SUBJECT_REQUIRED with the subjects in details.subjects.',
      'cash_account_id on a company-wide check answers 400 UNEXPLAINED_PARAMETER_NOT_ACCEPTED.',
    ],
    example: {
      request: { check_id: 'receivables_vs_ledger' },
      response: {
        data: {
          check_id: 'receivables_vs_ledger',
          name_sv: 'Kundreskontran mot bokförda kundfordringar',
          status: 'unexplained',
          subject: { kind: 'company' },
          difference: 3000,
          unit: 'SEK',
          as_of: '2026-10-16',
          summary_sv: EXAMPLE_ROW.summary_sv,
          sides: [],
          refusal: null,
          parts: [
            { key: 'register_without_voucher', label_sv: 'Öppna kundfakturor utan verifikat', label_en: 'Open customer invoices without a verifikat', amount: 3000, count: 1 },
            { key: 'ledger_without_invoice', label_sv: 'Verifikat på kundfordringskontona utan faktura i reskontran', label_en: 'Vouchers on the receivables accounts without an invoice in the register', amount: 0, count: 0 },
          ],
          residual: 0,
          reconciles: true,
          note: null,
          items: {
            list: [
              { part: 'register_without_voucher', item_type: 'invoice', invoice_id: 'a1b2…', handle: 'inv_a1b2…', date: '2026-10-01', label: 'Faktura 1002, Beta HB', amount: 3000, currency: 'SEK' },
            ],
            total: 1,
            offset: 0,
            next_offset: null,
          },
          next_action: { message_sv: 'Öppna förklaringen ...', tool: 'gnubok_link_invoice_to_voucher', screen: '/reports/kundreskontra' },
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      check_id: CHECK_ID,
      cash_account_id: z.string().uuid().optional().describe('bank_balance_vs_bank: the bank account (cash account id or cash_ handle).'),
      period_type: z.enum(['monthly', 'quarterly', 'yearly']).optional().describe('vat_declared_not_settled: the momsperiod length.'),
      year: z.coerce.number().int().min(2000).max(2100).optional().describe('vat_declared_not_settled: year of the momsperiod.'),
      period: z.coerce.number().int().min(1).max(12).optional().describe('vat_declared_not_settled: 1-12 monthly, 1-4 quarterly, 1 yearly.'),
      limit: z.coerce.number().int().min(1).max(200).optional().describe('Item page size, 1-200 (default 25).'),
      offset: z.coerce.number().int().min(0).optional().describe('Items to skip (next_offset of the previous page).'),
    })
    .strict(),
  output: ExplainOut,
  errorCodes: ERROR_CODES,
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/unexplained/:checkId/explain',
    pathParams: { checkId: 'check_id' },
  },
  mcp: {
    name: 'gnubok_explain_unexplained',
    title: 'Explain Unexplained Difference',
    description:
      'Explain a gnubok_list_unexplained row: the difference in parts and the items behind them (invoices, verifikat, bank rows, VAT accounts) with typed handles, paged, plus the residual. Pass the row\'s explain arguments.',
    keywords: ['förklara', 'differens', 'avstämning', 'verifikat'],
  },
  run: async (ctx, input) => {
    const { explainUnexplained } = await unexplained()
    return toOutcome<z.infer<typeof ExplainOut>>(
      await explainUnexplained(
        checkCtx(ctx),
        input.check_id,
        {
          ...(input.cash_account_id !== undefined ? { cash_account_id: input.cash_account_id } : {}),
          ...(input.period_type !== undefined ? { period_type: input.period_type } : {}),
          ...(input.year !== undefined ? { year: input.year } : {}),
          ...(input.period !== undefined ? { period: input.period } : {}),
        },
        { limit: input.limit, offset: input.offset },
      ),
    )
  },
})

export const UNEXPLAINED_OPERATIONS = [unexplainedList, unexplainedGet, unexplainedExplain] as const
