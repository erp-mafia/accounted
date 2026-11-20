/**
 * The liquidity forecast (accounted#136): the 13-week projection of the bank
 * balance, and the forecast rows people, the API and MCP clients add to it.
 * The projection's rules live in lib/forecast/build.ts, the rows' in
 * lib/forecast/rows.ts.
 *
 * The rows are not bookkeeping: no verifikat ever reads them. Their writes
 * therefore commit directly on both doors under forecast:write, without a
 * staged approval (mcp.direct; decision 2026-10-28). The forecast itself is
 * read with reports:read and never writes.
 */
import { z } from 'zod'
import { buildCashForecast, DEFAULT_FORECAST_WEEKS, MAX_FORECAST_WEEKS } from '@/lib/forecast/build'
import {
  cancelForecastRow,
  CancelForecastRowInput,
  ForecastRowView,
  listForecastRows,
  ListForecastRowsInput,
  MAX_UPSERT_BATCH,
  upsertForecastRows,
  UpsertForecastRowsInput,
} from '@/lib/forecast/rows'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const Money = z.number()
const Caveat = z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() })

const Flow = z.object({
  date: z.string(),
  direction: z.enum(['in', 'out']),
  amount: Money,
  kind: z.enum(['known', 'derived', 'forecast']),
  source: z.enum([
    'customer_invoice',
    'supplier_invoice',
    'payment_order',
    'salary_run',
    'salary_estimate',
    'skattekonto',
    'vat',
    'agi',
    'f_skatt',
    'recurring_invoice',
    'forecast_row',
  ]),
  estimate: z.boolean(),
  counterparty: z.string().nullable(),
  reference: z.string().nullable(),
  ref: z
    .object({
      type: z.enum([
        'invoice',
        'supplier_invoice',
        'payment_order',
        'salary_run',
        'recurring_invoice_schedule',
        'cash_forecast_row',
        'skattekonto',
        'vat_period',
        'agi_period',
      ]),
      id: z.string(),
    })
    .nullable(),
  confidence: z.enum(['firm', 'likely', 'possible']).nullable(),
})

const CashForecastOutput = z.object({
  currency: z.literal('SEK'),
  today: z.string(),
  horizon: z.object({ start: z.string(), end: z.string(), weeks: z.number().int() }),
  opening: z.object({
    amount: Money,
    source: z.enum(['bank', 'booked', 'unknown']),
    as_of: z.string().nullable(),
    age_days: z.number().int().nullable(),
    accounts: z.array(
      z.object({
        cash_account_id: z.string().nullable(),
        ledger_account: z.string(),
        name: z.string().nullable(),
        balance: Money,
        balance_updated_at: z.string().nullable(),
      }),
    ),
  }),
  days: z.array(
    z.object({ date: z.string(), opening: Money, inflow: Money, outflow: Money, closing: Money, lowest: z.boolean() }),
  ),
  weeks: z.array(
    z.object({
      iso_week: z.string(),
      start: z.string(),
      end: z.string(),
      opening: Money,
      inflow: Money,
      outflow: Money,
      closing: Money,
      min_closing: Money,
      lowest: z.boolean(),
    }),
  ),
  lowest: z.object({ date: z.string(), closing: Money, iso_week: z.string() }),
  closing: Money,
  flows: z.array(Flow),
  overdue: z.object({
    receivables: z.object({
      total: Money,
      invoices: z.array(
        z.object({
          invoice_id: z.string(),
          invoice_number: z.string(),
          customer_name: z.string(),
          due_date: z.string(),
          days_overdue: z.number().int(),
          amount: Money,
        }),
      ),
    }),
    payables: z.object({
      total: Money,
      invoices: z.array(
        z.object({
          supplier_invoice_id: z.string(),
          supplier_invoice_number: z.string().nullable(),
          supplier_name: z.string(),
          due_date: z.string(),
          days_overdue: z.number().int(),
          amount: Money,
        }),
      ),
    }),
  }),
  complete: z.boolean(),
  caveats: z.array(Caveat),
})

const EXAMPLE_ROW = {
  cash_forecast_row_id: '7b0e…',
  expected_date: '2026-11-20',
  amount: 48000,
  direction: 'in',
  currency: 'SEK',
  category: 'revenue',
  source: 'pms',
  external_source: 'boom',
  external_id: 'booking-48213',
  confidence: 'likely',
  dimension_value_id: null,
  invoice_id: null,
  supplier_invoice_id: null,
  status: 'open',
  matched_transaction_id: null,
  note: 'Bokning vecka 47',
  created_at: '2026-10-28T09:12:00Z',
  updated_at: '2026-10-28T09:12:00Z',
}

const ROWS_PITFALLS = [
  'Amounts are SEK and always positive; direction (in or out) says which way. Other currencies are not accepted yet.',
  'A row dated before today leaves the projection: cancel it, or move its date if the money is still expected.',
  'Link a row to its invoice (invoice_id or supplier_invoice_id) once the invoice exists: the invoice then counts and the row does not, so the money is never counted twice.',
]

// ---------------------------------------------------------------------------
// The forecast
// ---------------------------------------------------------------------------

export const cashForecastGet = defineOperation({
  id: 'cash-forecast.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The 13-week liquidity forecast: where the bank balance is heading, by day and by ISO week.',
    description:
      'Projects the bank balance from today: the opening balance (the banks\' last reported balance, or the booked bank balance when no bank reports one, labelled), then every expected flow: open customer and supplier invoices on their due dates, the bank payment queue on its dates, salary runs as net pay, taxes through the skattekonto (Skatteverket\'s own debits, F-skatt, VAT and AGI), recurring invoices not created yet, and forecast rows. Answers 30 days by day and 13 ISO weeks (weeks, at most 26) as opening + in - out = closing, the lowest point flagged, and overdue invoices listed apart. Each flow is tagged known, derived or forecast; estimates say so. Read-only.',
    useWhen: 'To answer "will we have money for X", find the week the balance is lowest, or plan payments.',
    doNotUseFor:
      'The historical cash flow (GET /reports/kassaflodesanalys) or what is booked on the bank accounts (GET /measures/bank_balance).',
    pitfalls: [
      'Each krona counts once: an invoice inside a payment order counts at the order\'s date; a salary run as net pay, its tax and avgifter through the skattekonto on the AGI\'s due date; a forecast row linked to an invoice yields to it.',
      'Overdue invoices are listed under overdue, not projected: nothing says when they will be paid.',
      'complete=false means a source could not be read; its caveat (SOURCE_UNAVAILABLE) names it.',
      'Estimates are flagged: VAT for a period not yet declared is the books so far; salary for a month without a run repeats the latest run.',
    ],
    example: {
      request: { weeks: 13 },
      response: {
        data: {
          currency: 'SEK',
          today: '2026-10-28',
          horizon: { start: '2026-10-28', end: '2027-01-24', weeks: 13 },
          opening: { amount: 412500, source: 'bank', as_of: '2026-10-28T05:02:11Z', age_days: 0, accounts: [] },
          days: [{ date: '2026-10-28', opening: 412500, inflow: 0, outflow: 18750, closing: 393750, lowest: false }],
          weeks: [
            { iso_week: '2026-W44', start: '2026-10-26', end: '2026-11-01', opening: 412500, inflow: 62000, outflow: 18750, closing: 455750, min_closing: 393750, lowest: false },
          ],
          lowest: { date: '2026-11-25', closing: 121300, iso_week: '2026-W48' },
          closing: 286400,
          flows: [
            { date: '2026-10-28', direction: 'out', amount: 18750, kind: 'known', source: 'payment_order', estimate: false, counterparty: 'Städbolaget AB', reference: 'F-2026-118', ref: { type: 'payment_order', id: '5c2a…' }, confidence: null },
          ],
          overdue: { receivables: { total: 0, invoices: [] }, payables: { total: 0, invoices: [] } },
          complete: true,
          caveats: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    weeks: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_FORECAST_WEEKS)
      .optional()
      .describe(`ISO weeks to project, the current week first. Default ${DEFAULT_FORECAST_WEEKS}.`),
  }),
  output: CashForecastOutput,
  errorCodes: ['CASH_FORECAST_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/cash-forecast' },
  mcp: {
    name: 'gnubok_get_cash_forecast',
    title: 'Get Cash Forecast (13 weeks)',
    description:
      'Liquidity forecast: bank balance by day (30) and ISO week (13) from open invoices, payment orders, salary, skattekonto/VAT/AGI, recurring invoices and forecast rows. Lowest point flagged, overdue listed apart, estimates tagged.',
    keywords: ['likviditet', 'likviditetsprognos', 'kassaprognos', 'kassaflöde', 'prognos', 'banksaldo', 'cash forecast', 'räcker pengarna'],
  },
  run: async (ctx, input) => {
    try {
      const forecast = await buildCashForecast(ctx.supabase, ctx.companyId, { weeks: input.weeks })
      return { ok: true, data: forecast }
    } catch (err) {
      ctx.log.error('cash forecast failed', { error: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'CASH_FORECAST_FAILED' }
    }
  },
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const cashForecastRowsList = defineOperation({
  id: 'cash-forecast-rows.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The forecast rows: money expected in or out that the books do not hold yet.',
    description:
      'Lists the company\'s forecast rows by expected date: amount, direction, category, confidence, the outside key (external_source, external_id) and status (open, realised, superseded, cancelled). Filter by status, date range and outside system. Paginated with limit and offset; total is the full count. Read-only.',
    useWhen: 'To see what has been added to the liquidity forecast, or to find a row to change or cancel.',
    doNotUseFor: 'The projection itself (GET /cash-forecast).',
    pitfalls: ROWS_PITFALLS,
    example: { request: { status: 'open' }, response: { data: { rows: [EXAMPLE_ROW], total: 1 }, meta: META } },
  },
  input: ListForecastRowsInput,
  output: z.object({ rows: z.array(ForecastRowView), total: z.number().int() }),
  errorCodes: ['CASH_FORECAST_ROWS_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/cash-forecast-rows' },
  mcp: {
    name: 'gnubok_list_cash_forecast_rows',
    title: 'List Cash Forecast Rows',
    description: 'The liquidity forecast\'s own rows (expected money in or out not in the books yet), by expected date. Filter by status, dates and external_source.',
    keywords: ['prognosrad', 'prognosrader', 'likviditetsprognos', 'kassaprognos', 'förväntade inbetalningar', 'förväntade utbetalningar'],
  },
  run: (ctx, input) => listForecastRows(ctx, input),
})

export const cashForecastRowsUpsertBatch = defineOperation({
  id: 'cash-forecast-rows.upsert-batch',
  kind: 'write',
  scope: 'forecast:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Add or update forecast rows by your own key, up to 500 at a time.',
    description:
      `Writes rows to the liquidity forecast, each named by your system and its id (external_source, external_id): a key not seen before creates a row, a key seen before updates that row while it is open. A row that is realised, superseded or cancelled is left as it is and listed under skipped. Not bookkeeping: rows never reach the books, so they are written directly (no approval) under forecast:write. Up to ${MAX_UPSERT_BATCH} rows per call. Dry-runnable.`,
    useWhen: 'A system that knows future money (bookings in a property management system, a loan plan, planned purchases) feeds the forecast, or an agent adds an expected payment.',
    doNotUseFor: 'Booking anything: a forecast row is never a verifikat. Customer and supplier invoices already count on their own.',
    pitfalls: [
      ...ROWS_PITFALLS,
      'Sending the same batch again changes nothing: the key names the row. A cancelled row is not reopened by a later upsert.',
    ],
    example: {
      request: {
        rows: [
          { external_source: 'boom', external_id: 'booking-48213', expected_date: '2026-11-20', amount: 48000, direction: 'in', category: 'revenue', note: 'Bokning vecka 47' },
        ],
        source: 'pms',
      },
      response: { data: { rows: [EXAMPLE_ROW], created: 1, updated: 0, skipped: [] }, meta: META },
    },
  },
  input: UpsertForecastRowsInput,
  output: z.object({
    rows: z.array(ForecastRowView),
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.array(
      z.object({
        cash_forecast_row_id: z.string().uuid(),
        external_source: z.string(),
        external_id: z.string(),
        status: z.enum(['open', 'realised', 'superseded', 'cancelled']),
      }),
    ),
  }),
  errorCodes: ['CASH_FORECAST_ROW_REFERENCE_NOT_FOUND', 'CASH_FORECAST_ROWS_CONFLICT', 'CASH_FORECAST_ROWS_READ_FAILED', 'CASH_FORECAST_ROWS_WRITE_FAILED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/cash-forecast-rows' },
  mcp: {
    name: 'gnubok_upsert_cash_forecast_rows',
    title: 'Upsert Cash Forecast Rows',
    description:
      'Add or update liquidity forecast rows by external_source + external_id (up to 500). Written directly, no approval: a forecast row never reaches the books. Resending the same key updates the open row.',
    keywords: ['prognosrad', 'lägg till prognos', 'likviditetsprognos', 'kassaprognos', 'förväntad inbetalning', 'förväntad utbetalning', 'bokningar', 'pms'],
    direct: true,
  },
  run: (ctx, input, { dryRun }) => upsertForecastRows(ctx, input, { dryRun }),
})

export const cashForecastRowsCancel = defineOperation({
  id: 'cash-forecast-rows.cancel',
  kind: 'write',
  scope: 'forecast:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Cancel a forecast row: it leaves the forecast and stays on record.',
    description:
      'Sets an open row\'s status to cancelled; rows are never deleted. Name the row by cash_forecast_row_id, or by your own external_source and external_id. Cancelling a cancelled row changes nothing; a realised or superseded row cannot be cancelled. Not bookkeeping: written directly under forecast:write. Dry-runnable.',
    useWhen: 'Money that was expected will not come or go: a booking cancelled, a purchase dropped.',
    doNotUseFor: 'Changing a row\'s amount or date (upsert it with the same key).',
    pitfalls: ['A cancelled row is not reopened by a later upsert of the same key: write a new key if the money is expected again.'],
    example: {
      request: { external_source: 'boom', external_id: 'booking-48213' },
      response: { data: { row: { ...EXAMPLE_ROW, status: 'cancelled' } }, meta: META },
    },
  },
  input: CancelForecastRowInput,
  output: z.object({ row: ForecastRowView }),
  errorCodes: ['CASH_FORECAST_ROW_NOT_FOUND', 'CASH_FORECAST_ROW_NOT_OPEN', 'CASH_FORECAST_ROWS_READ_FAILED', 'CASH_FORECAST_ROWS_WRITE_FAILED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/cash-forecast-rows/cancel' },
  mcp: {
    name: 'gnubok_cancel_cash_forecast_row',
    title: 'Cancel Cash Forecast Row',
    description:
      'Cancel one liquidity forecast row by cash_forecast_row_id or external_source + external_id. Kept on record, never deleted; written directly, no approval.',
    keywords: ['stryk prognosrad', 'avbryt prognos', 'likviditetsprognos', 'kassaprognos', 'avbokning'],
    direct: true,
  },
  run: (ctx, input, { dryRun }) => cancelForecastRow(ctx, input, { dryRun }),
})

export const CASH_FORECAST_OPERATIONS = [
  cashForecastGet,
  cashForecastRowsList,
  cashForecastRowsUpsertBatch,
  cashForecastRowsCancel,
] as const
