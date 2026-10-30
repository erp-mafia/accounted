/**
 * Budget operations (accounted#134): named budget versions per räkenskapsår,
 * their amounts per resultatkonto, month and dimension, and the comparison
 * with the books. Rules live in lib/budgets/service.ts and the database
 * (20261031121100_budgets.sql); this file is the v1 and MCP contract.
 *
 * Every MCP binding is search-only: tools/list is at its size ceiling, and
 * gnubok_search_tools finds these by their Swedish keywords. Writes stage at
 * low risk: a budget is planning data, never a booking.
 */
import { z } from 'zod'
import {
  BudgetVsActualInputSchema,
  CopyActualsInputSchema,
  CreateBudgetInputSchema,
  DeleteBudgetInputSchema,
  GetBudgetInputSchema,
  ListBudgetsInputSchema,
  SpreadInputSchema,
  UpdateBudgetInputSchema,
  UpsertBudgetLinesInputSchema,
} from '@/lib/budgets/schemas'
import {
  budgetVsActual,
  copyActualsToBudget,
  createBudget,
  deleteBudget,
  getBudget,
  listBudgets,
  spreadBudget,
  updateBudget,
  upsertBudgetLines,
} from '@/lib/budgets/service'
import { BUDGET_EXAMPLE_ACCOUNTS } from '@/lib/bookkeeping/bas-data/result-accounts'
import { defineOperation, type AnyOperation } from './types'

const { sales: SALES, rent: RENT } = BUDGET_EXAMPLE_ACCOUNTS

const Budget = z.object({
  budget_id: z.string().uuid(),
  fiscal_period_id: z.string().uuid(),
  name: z.string(),
  is_default: z.boolean(),
  archived: z.boolean(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const BudgetLine = z.object({
  budget_line_id: z.string().uuid(),
  account_number: z.string(),
  month: z.string().describe('YYYY-MM'),
  dimensions: z.record(z.string(), z.string()),
  amount: z.number().describe('SIE sign: debit positive, revenue negative.'),
})

const SaveCounts = {
  budget_id: z.string().uuid(),
  inserted: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  unchanged: z.number().int(),
}

const Figures = z.object({
  budget: z.number(),
  actual: z.number(),
  deviation: z.number(),
  deviation_percent: z.number().nullable(),
})
const MonthFigures = Figures.extend({ month: z.string() })

const BUDGET_EXAMPLE = {
  budget_id: '7c1d…',
  fiscal_period_id: 'a8f1…',
  name: 'Budget 2027',
  is_default: true,
  archived: false,
  archived_at: null,
  created_at: '2026-11-02T09:00:00Z',
  updated_at: '2026-11-02T09:00:00Z',
}
const META = { request_id: 'req_…', api_version: '2026-05-12' }
const BUDGETS_PATH = '/api/v1/companies/:companyId/budgets'
const BUDGET_PATH = '/api/v1/companies/:companyId/budgets/:id'
const SIGN_PITFALL =
  'Amounts are in the SIE sign, debit positive: a revenue budget on class 3 is NEGATIVE (-1200000 for 1,2 Mkr sales), a cost budget positive.'

export const budgetsList = defineOperation({
  id: 'budgets.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the budgets (named versions per fiscal year).',
    description:
      'Returns the company\'s budgets, oldest first: each is one named version of a fiscal year\'s budget, and at most one per year is the default that reports read when no budget is named. Archived budgets are left out unless include_archived is true.',
    useWhen: 'Before reading or changing a budget, to find its budget_id, or to see which version of a year is the default.',
    doNotUseFor: 'The amounts themselves (GET /budgets/{id}) or the comparison with the books (GET /reports/budget-vs-actual).',
    pitfalls: ['A company without budgets gets an empty list.'],
    example: { response: { data: { budgets: [BUDGET_EXAMPLE] }, meta: META } },
  },
  input: ListBudgetsInputSchema,
  output: z.object({ budgets: z.array(Budget) }),
  http: { method: 'GET', path: BUDGETS_PATH },
  mcp: {
    name: 'gnubok_list_budgets',
    title: 'List Budgets',
    description: 'List the budgets: named versions per fiscal year, with which one is the default. Filter by fiscal_period_id.',
    keywords: ['budget', 'budgetar', 'prognos', 'budgetversion', 'årsbudget'],
  },
  run: (ctx, input) => listBudgets(ctx, input),
})

export const budgetsGet = defineOperation({
  id: 'budgets.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one budget and its amounts per account, month and dimension.',
    description:
      'Returns the budget and its lines, ordered by account and month, paged (limit, offset; has_more and total_lines say whether more follow). A line is one amount for one resultatkonto, one month and one dimension tag ({} untagged).',
    useWhen: 'To read or check the amounts of a budget, e.g. before changing them.',
    doNotUseFor: 'Budget against booked result (GET /reports/budget-vs-actual).',
    pitfalls: [SIGN_PITFALL, 'A month with no line has no budget (0).'],
    example: {
      response: {
        data: {
          budget: BUDGET_EXAMPLE,
          lines: [{ budget_line_id: '0b3e…', account_number: SALES, month: '2027-01', dimensions: {}, amount: -100000 }],
          total_lines: 1,
          has_more: false,
        },
        meta: META,
      },
    },
  },
  input: GetBudgetInputSchema,
  output: z.object({ budget: Budget, lines: z.array(BudgetLine), total_lines: z.number().int(), has_more: z.boolean() }),
  errorCodes: ['BUDGET_NOT_FOUND'],
  http: { method: 'GET', path: BUDGET_PATH, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_get_budget',
    title: 'Get Budget',
    description: 'Read a budget with its amounts per account, month and dimension tag (SIE sign: revenue negative). Paged.',
    keywords: ['budget', 'budgetbelopp', 'budgetrader'],
  },
  run: (ctx, input) => getBudget(ctx, input),
})

export const budgetsCreate = defineOperation({
  id: 'budgets.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Create a budget for a fiscal year.',
    description:
      'Creates an empty, named budget version for one fiscal year. The name is unique within the year. The first budget of a year becomes its default unless is_default is false; is_default true on a later one moves the default to it. Fill it with POST /budgets/{id}/lines, /copy-actuals or /spread. Dry-runnable.',
    useWhen: 'Starting a year\'s budget, or a second version of it (a forecast, a scenario).',
    doNotUseFor: 'Changing an existing budget (PATCH /budgets/{id}).',
    pitfalls: [
      'A name the year already has (case ignored) answers 409 BUDGET_NAME_TAKEN.',
      'fiscal_period_id must be one of the company\'s fiscal years: 404 PERIOD_NOT_FOUND.',
    ],
    example: {
      request: { fiscal_period_id: 'a8f1…', name: 'Budget 2027' },
      response: { data: { budget: BUDGET_EXAMPLE }, meta: META },
    },
  },
  input: CreateBudgetInputSchema,
  output: z.object({ budget: Budget }),
  errorCodes: ['PERIOD_NOT_FOUND', 'BUDGET_NAME_TAKEN'],
  http: { method: 'POST', path: BUDGETS_PATH },
  mcp: {
    name: 'gnubok_create_budget',
    title: 'Create Budget',
    description:
      'Stage a new named budget for a fiscal year (the first one becomes the year\'s default). Fill it with gnubok_copy_actuals_to_budget, gnubok_spread_budget or gnubok_upsert_budget_lines.',
    keywords: ['skapa budget', 'ny budget', 'budget', 'prognos'],
    stage: { pendingType: 'create_budget', title: (input) => `Ny budget: ${String(input.name)}` },
  },
  run: (ctx, input, { dryRun }) => createBudget(ctx, input, { dryRun }),
})

export const budgetsUpdate = defineOperation({
  id: 'budgets.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Rename a budget, make it the default, or archive or restore it.',
    description:
      'Sparse update: name, is_default (true moves the year\'s default to this budget), archived (true makes it read-only and never the default; false restores it). The fiscal year of a budget never changes. Dry-runnable.',
    useWhen: 'Choosing which version a year\'s reports read, renaming one, or putting an old version aside.',
    doNotUseFor: 'Changing amounts (POST /budgets/{id}/lines).',
    pitfalls: [
      'Send at least one of name, is_default, archived.',
      'An archived budget cannot be the default: 409 BUDGET_ARCHIVED.',
    ],
    example: {
      request: { is_default: true },
      response: { data: { budget: BUDGET_EXAMPLE }, meta: META },
    },
  },
  input: UpdateBudgetInputSchema,
  output: z.object({ budget: Budget }),
  errorCodes: ['BUDGET_NOT_FOUND', 'BUDGET_NAME_TAKEN', 'BUDGET_ARCHIVED'],
  http: { method: 'PATCH', path: BUDGET_PATH, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_update_budget',
    title: 'Update Budget',
    description: 'Stage a rename of a budget, making it the year\'s default, or archiving or restoring it.',
    keywords: ['ändra budget', 'standardbudget', 'arkivera budget'],
    stage: { pendingType: 'update_budget', title: () => 'Ändra budget' },
  },
  run: (ctx, input, { dryRun }) => updateBudget(ctx, input, { dryRun }),
})

export const budgetsDelete = defineOperation({
  id: 'budgets.delete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Delete a budget and its amounts.',
    description:
      'Removes the budget and every amount in it. A budget is planning data, not räkenskapsinformation (BFL 7 kap.), so it can be deleted at any time; the audit log keeps who did it. Archiving keeps it instead (PATCH archived=true). Dry-runnable: the preview counts the lines.',
    useWhen: 'A budget version is no longer wanted.',
    doNotUseFor: 'Putting a version aside but keeping it (PATCH archived=true).',
    pitfalls: ['A budget of another company, or one already deleted, answers 404 BUDGET_NOT_FOUND.'],
    example: { response: { data: { deleted: true, budget_id: '7c1d…' }, meta: META } },
  },
  input: DeleteBudgetInputSchema,
  output: z.object({ deleted: z.literal(true), budget_id: z.string().uuid() }),
  errorCodes: ['BUDGET_NOT_FOUND'],
  http: { method: 'DELETE', path: BUDGET_PATH, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_delete_budget',
    title: 'Delete Budget',
    description: 'Stage deleting a budget and all its amounts. Archive it instead with gnubok_update_budget (archived=true) to keep it.',
    keywords: ['ta bort budget', 'radera budget'],
    hints: { destructive: true },
    stage: { pendingType: 'delete_budget', title: (_input, preview) => `Ta bort budget${preview?.name ? `: ${String(preview.name)}` : ''}` },
  },
  run: (ctx, { budget_id }, { dryRun }) => deleteBudget(ctx, budget_id, { dryRun }),
})

export const budgetsLinesUpsert = defineOperation({
  id: 'budgets.lines.upsert',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Save amounts in a budget (account, month, dimension cells).',
    description:
      'Writes each cell: one resultatkonto (3000-8999), one month (YYYY-MM) and one dimension tag ({} or omitted for untagged). A cell that exists gets the new amount, a new one is added, and amount 0 removes the cell. Every cell is saved or none is. The answer counts inserted, updated, deleted and unchanged cells. Dry-runnable.',
    useWhen: 'Entering or adjusting budget amounts by hand, or loading a budget prepared elsewhere.',
    doNotUseFor: 'Last year\'s figures (POST /copy-actuals) or a yearly amount spread over the months (POST /spread).',
    pitfalls: [
      SIGN_PITFALL,
      'The account must be in the chart of accounts: 404 BUDGET_ACCOUNT_NOT_FOUND lists the missing ones.',
      'Months must lie in the budget\'s fiscal year: 400 BUDGET_MONTH_OUTSIDE_YEAR.',
      'One cell once per call: 400 BUDGET_LINES_DUPLICATE.',
      'An archived budget is read-only: 409 BUDGET_ARCHIVED.',
    ],
    example: {
      request: { lines: [{ account_number: SALES, month: '2027-01', amount: -100000 }, { account_number: RENT, month: '2027-01', dimensions: { '6': 'P001' }, amount: 12000 }] },
      response: { data: { budget_id: '7c1d…', inserted: 2, updated: 0, deleted: 0, unchanged: 0 }, meta: META },
    },
  },
  input: UpsertBudgetLinesInputSchema,
  output: z.object(SaveCounts),
  errorCodes: ['BUDGET_NOT_FOUND', 'BUDGET_ARCHIVED', 'BUDGET_ACCOUNT_NOT_FOUND', 'BUDGET_MONTH_OUTSIDE_YEAR', 'BUDGET_LINES_DUPLICATE'],
  http: { method: 'POST', path: `${BUDGET_PATH}/lines`, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_upsert_budget_lines',
    title: 'Save Budget Amounts',
    description:
      'Stage saving budget cells: account (3000-8999), month YYYY-MM, optional dimension tag, amount in SIE sign (revenue negative, costs positive; 0 removes). All cells save or none.',
    keywords: ['budgetbelopp', 'budgetera', 'spara budget', 'budget per konto', 'budget per månad'],
    stage: {
      pendingType: 'upsert_budget_lines',
      title: (input) => {
        const n = Array.isArray(input.lines) ? input.lines.length : 0
        return `Spara ${n} budgetbelopp`
      },
    },
  },
  run: (ctx, input, { dryRun }) => upsertBudgetLines(ctx, input, { dryRun }),
})

export const budgetsCopyActuals = defineOperation({
  id: 'budgets.copy-actuals',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Fill a budget with last year\'s booked result, optionally scaled.',
    description:
      'Reads the booked result per resultatkonto and month of the source year (default: the year before the budget\'s year), with the resultatrapport\'s exclusions (no bokslut entries), and writes it into the budget month by month: March to March, scaled by percent_change. Each copied account gets every month of the year, so copying again replaces the earlier copy; accounts without actuals are left alone. With dimensions, only the tagged actuals are copied, into lines with the same tag. Dry-runnable.',
    useWhen: 'Starting a budget from last year\'s figures, e.g. "last year plus 5 %".',
    doNotUseFor: 'A yearly amount for one account (POST /spread).',
    pitfalls: [
      'Without a previous fiscal year, name one with source_fiscal_period_id: 404 BUDGET_SOURCE_YEAR_NOT_FOUND.',
      'Months are matched by calendar month; a source year that holds a month twice (18 months) gives its later one.',
    ],
    example: {
      request: { percent_change: 5 },
      response: {
        data: { budget_id: '7c1d…', inserted: 24, updated: 0, deleted: 0, unchanged: 0, source_fiscal_period_id: '5c2e…', accounts: [SALES, RENT] },
        meta: META,
      },
    },
  },
  input: CopyActualsInputSchema,
  output: z.object({ ...SaveCounts, source_fiscal_period_id: z.string().uuid(), accounts: z.array(z.string()) }),
  errorCodes: ['BUDGET_NOT_FOUND', 'BUDGET_ARCHIVED', 'BUDGET_SOURCE_YEAR_NOT_FOUND', 'PERIOD_NOT_FOUND', 'BUDGET_ACCOUNT_NOT_FOUND'],
  http: { method: 'POST', path: `${BUDGET_PATH}/copy-actuals`, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_copy_actuals_to_budget',
    title: 'Copy Actuals To Budget',
    description:
      'Stage filling a budget with last year\'s booked result per account and month, optionally scaled by percent_change (5 = +5 %), optionally for one dimension tag.',
    keywords: ['förra årets utfall', 'kopiera utfall', 'budget från utfall', 'fjolårets siffror'],
    stage: {
      pendingType: 'copy_budget_actuals',
      title: (input) =>
        typeof input.percent_change === 'number' && input.percent_change !== 0
          ? `Budget från förra årets utfall ${input.percent_change > 0 ? '+' : ''}${input.percent_change} %`
          : 'Budget från förra årets utfall',
    },
  },
  run: (ctx, input, { dryRun }) => copyActualsToBudget(ctx, input, { dryRun }),
})

export const budgetsSpread = defineOperation({
  id: 'budgets.spread',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Spread a yearly amount over the months of a budget.',
    description:
      'Writes one account\'s yearly amount into every month of the budget\'s fiscal year: evenly (method even), or in proportion to the account\'s booked months last year (method last_year, so a seasonal account keeps its season). Each month is whole öre and the last month takes the remainder, so the months add up to the amount exactly. A last year that sums to zero falls back to even (fell_back_to_even). Dry-runnable: the preview shows the months.',
    useWhen: 'The budget for an account is known per year ("3010: 1,2 Mkr").',
    doNotUseFor: 'Different amounts per month (POST /lines).',
    pitfalls: [SIGN_PITFALL, 'The account\'s earlier months in the budget (same tag) are replaced.'],
    example: {
      request: { account_number: SALES, amount: -1200000, method: 'last_year' },
      response: {
        data: {
          budget_id: '7c1d…',
          inserted: 12,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          account_number: SALES,
          method: 'last_year',
          fell_back_to_even: false,
          months: [{ month: '2027-01', amount: -80000 }],
        },
        meta: META,
      },
    },
  },
  input: SpreadInputSchema,
  output: z.object({
    ...SaveCounts,
    account_number: z.string(),
    method: z.enum(['even', 'last_year']),
    fell_back_to_even: z.boolean(),
    months: z.array(z.object({ month: z.string(), amount: z.number() })),
  }),
  errorCodes: ['BUDGET_NOT_FOUND', 'BUDGET_ARCHIVED', 'BUDGET_SOURCE_YEAR_NOT_FOUND', 'BUDGET_ACCOUNT_NOT_FOUND'],
  http: { method: 'POST', path: `${BUDGET_PATH}/spread`, pathParams: { id: 'budget_id' } },
  mcp: {
    name: 'gnubok_spread_budget',
    title: 'Spread Budget Amount',
    description:
      'Stage spreading one account\'s yearly budget over the months, evenly or by last year\'s months (method last_year). SIE sign: revenue negative. The months add up exactly.',
    keywords: ['fördela budget', 'periodisera budget', 'årsbelopp', 'säsong'],
    stage: { pendingType: 'spread_budget', title: (input) => `Fördela budget på konto ${String(input.account_number)}` },
  },
  run: (ctx, input, { dryRun }) => spreadBudget(ctx, input, { dryRun }),
})

export const reportsBudgetVsActual = defineOperation({
  id: 'reports.budget-vs-actual',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Budget against booked result per account and month.',
    description:
      'For every resultatkonto with a budget or a booked amount in the window: budget, actual, deviation (actual minus budget) and deviation_percent per month and in total, plus the result over all accounts. Figures are in the resultatrapport\'s sign (revenue positive, costs negative), so a positive deviation is always a better result than budgeted. Actuals leave out the bokslut entries, as the resultatrapport does. The window is whole months (from_month..to_month, default the whole year). dim_no + dim_code compare one dimension value: actuals and budget lines tagged with it.',
    useWhen: 'Following up a budget: year to date, one month, or one project or cost centre.',
    doNotUseFor: 'The budget\'s raw amounts (GET /budgets/{id}).',
    pitfalls: [
      'Without budget_id the year\'s default budget is read: 404 BUDGET_NONE_FOR_YEAR when there is none.',
      'Months outside the budget\'s fiscal year answer 400 BUDGET_MONTH_OUTSIDE_YEAR.',
      'Without a dimension filter every budget line counts, tagged or not.',
      'deviation_percent is null where nothing is budgeted.',
    ],
    example: {
      response: {
        data: {
          budget: BUDGET_EXAMPLE,
          fiscal_period: { fiscal_period_id: 'a8f1…', name: 'Räkenskapsår 2027', period_start: '2027-01-01', period_end: '2027-12-31' },
          from_month: '2027-01',
          to_month: '2027-03',
          dimension_filter: null,
          months: ['2027-01', '2027-02', '2027-03'],
          rows: [],
          totals: { months: [], total: { budget: 0, actual: 0, deviation: 0, deviation_percent: null } },
        },
        meta: META,
      },
    },
  },
  input: BudgetVsActualInputSchema,
  output: z.object({
    budget: Budget,
    fiscal_period: z.object({ fiscal_period_id: z.string().uuid(), name: z.string(), period_start: z.string(), period_end: z.string() }),
    from_month: z.string(),
    to_month: z.string(),
    dimension_filter: z.record(z.string(), z.string()).nullable(),
    months: z.array(z.string()),
    rows: z.array(
      z.object({
        account_number: z.string(),
        account_name: z.string().nullable(),
        months: z.array(MonthFigures),
        total: Figures,
      }),
    ),
    totals: z.object({ months: z.array(MonthFigures), total: Figures }),
  }),
  errorCodes: ['BUDGET_NOT_FOUND', 'BUDGET_NONE_FOR_YEAR', 'PERIOD_NOT_FOUND', 'BUDGET_MONTH_OUTSIDE_YEAR'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/budget-vs-actual' },
  mcp: {
    name: 'gnubok_budget_vs_actual',
    title: 'Budget Vs Actual',
    description:
      'Budget against booked result per account and month (resultatrapport sign, positive deviation = better than budget). Whole months; filter one dimension value with dim_no + dim_code.',
    keywords: ['budget mot utfall', 'budgetuppföljning', 'avvikelse', 'utfall mot budget', 'budget vs utfall'],
  },
  run: (ctx, input) => budgetVsActual(ctx, input),
})

export const BUDGET_OPERATIONS: readonly AnyOperation[] = [
  budgetsList,
  budgetsGet,
  budgetsCreate,
  budgetsUpdate,
  budgetsDelete,
  budgetsLinesUpsert,
  budgetsCopyActuals,
  budgetsSpread,
  reportsBudgetVsActual,
]
