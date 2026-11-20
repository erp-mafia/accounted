/**
 * Budgets (accounted#134): named budget versions per räkenskapsår, their
 * amounts per resultatkonto, month and dimension tag, and the comparison with
 * the books. The one implementation behind the v1 and MCP operations
 * (lib/operations/budgets.ts); the dashboard's grid (part 2) calls it too.
 *
 * Rules that live in the database (supabase/migrations/20261031121100):
 * one default per year (setting one takes it from the others), a unique name
 * per year, months inside the year, accounts in the kontoplan, archived
 * budgets read-only, and the atomic grid save (upsert_budget_lines), which
 * every write of amounts here goes through, so a copy or a spread is saved
 * exactly like a hand-edited grid.
 *
 * A budget is planning data, not räkenskapsinformation: it is deleted
 * freely. Any member who may write may write budgets (RLS on
 * caller_can_write_company), so there is no owner/admin gate. The v1 and MCP
 * doors run on the service role, so every read and write here filters on
 * ctx.companyId, and the budget is looked up for the company before the RPC
 * is called with its id.
 */
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import { roundOre } from '@/lib/money'
import { RESULTATKONTO_FIRST, RESULTATKONTO_LAST } from '@/lib/bookkeeping/bas-data/result-accounts'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { computeBudgetVsActual, type BudgetVsActualTable } from './budget-vs-actual'
import { copyActualsToMonths, type AccountMonthAmount } from './copy'
import { firstDayOf, fiscalYearMonths, lastDayOf, monthOf, monthsBetween } from './months'
import { profileFromActuals, spreadByProfile, spreadEvenly, type MonthAmount } from './spread'
import { readBudgetSums } from './sums'
import type {
  BudgetLineInput,
  BudgetGridInput,
  BudgetVsActualInput,
  CopyActualsInput,
  CreateBudgetInput,
  GetBudgetInput,
  ListBudgetsInput,
  SpreadInput,
  UpdateBudgetInput,
  UpsertBudgetLinesInput,
} from './schemas'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const failed = (error: unknown): Failure => ({ ok: false, code: 'UNKNOWN_ERROR', error })

/**
 * The company's budgets, read with the public columns. A literal select, so
 * the schema guard (tests/schema/no-phantom-columns.test.ts) checks every
 * column; the insert and update below spell the same list.
 */
function budgetsOf(ctx: OperationContext) {
  return ctx.supabase.from('budgets').select('id, fiscal_period_id, name, is_default, archived_at, created_at, updated_at').eq('company_id', ctx.companyId)
}

interface BudgetRow {
  id: string
  fiscal_period_id: string
  name: string
  is_default: boolean
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  previous_period_id: string | null
}

/** The public shape of a budget: qualified ids throughout. */
export function toBudgetDto(row: BudgetRow) {
  return {
    budget_id: row.id,
    fiscal_period_id: row.fiscal_period_id,
    name: row.name,
    is_default: row.is_default,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export type BudgetDto = ReturnType<typeof toBudgetDto>

export interface BudgetLineDto {
  budget_line_id: string
  account_number: string
  /** 'YYYY-MM' */
  month: string
  dimensions: Record<string, string>
  /** SIE sign: debit positive. */
  amount: number
}

export interface BudgetSaveCounts {
  budget_id: string
  inserted: number
  updated: number
  deleted: number
  unchanged: number
}

export async function loadBudget(ctx: OperationContext, budgetId: string): Promise<{ budget: BudgetRow } | { failure: Failure }> {
  const { data, error } = await budgetsOf(ctx).eq('id', budgetId).maybeSingle()
  if (error) return { failure: failed(error) }
  if (!data) return { failure: { ok: false, code: 'BUDGET_NOT_FOUND', details: { budget_id: budgetId } } }
  return { budget: data as BudgetRow }
}

export async function loadPeriod(ctx: OperationContext, periodId: string): Promise<{ period: PeriodRow } | { failure: Failure }> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, previous_period_id')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return { failure: failed(error) }
  if (!data) return { failure: { ok: false, code: 'PERIOD_NOT_FOUND', details: { fiscal_period_id: periodId } } }
  return { period: data as PeriodRow }
}

/** The year whose actuals a copy or a profile reads: the one named, or the year before. */
async function loadSourcePeriod(
  ctx: OperationContext,
  budgetPeriod: PeriodRow,
  sourceId: string | undefined,
): Promise<{ period: PeriodRow } | { failure: Failure }> {
  if (sourceId) return loadPeriod(ctx, sourceId)
  try {
    const previous = await resolvePreviousFiscalPeriod<PeriodRow>(
      ctx.supabase,
      ctx.companyId,
      budgetPeriod,
      'id, name, period_start, period_end, previous_period_id',
    )
    if (!previous) {
      return { failure: { ok: false, code: 'BUDGET_SOURCE_YEAR_NOT_FOUND', details: { fiscal_period_id: budgetPeriod.id } } }
    }
    return { period: previous }
  } catch (error) {
    return { failure: failed(error) }
  }
}

/** The budget's other budgets in its year, for the name rule. */
async function nameTaken(ctx: OperationContext, periodId: string, name: string, exceptId?: string): Promise<boolean | Failure> {
  const { data, error } = await ctx.supabase
    .from('budgets')
    .select('id, name')
    .eq('company_id', ctx.companyId)
    .eq('fiscal_period_id', periodId)
  if (error) return failed(error)
  const wanted = name.toLocaleLowerCase('sv-SE')
  return ((data ?? []) as { id: string; name: string }[]).some(
    (b) => b.id !== exceptId && b.name.toLocaleLowerCase('sv-SE') === wanted,
  )
}

/**
 * The name rule's own violation (budgets_name_per_year). A race on the
 * default (budgets_one_default_per_year) is not a taken name: it stays an
 * unknown error the caller may retry.
 */
function isNameTaken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message, details } = error as { code?: string; message?: string; details?: string }
  return code === '23505' && `${message ?? ''} ${details ?? ''}`.includes('budgets_name_per_year')
}

// ── Budgets ─────────────────────────────────────────────────────────────

export async function listBudgets(
  ctx: OperationContext,
  input: ListBudgetsInput,
): Promise<OperationOutcome<{ budgets: BudgetDto[] }>> {
  try {
    const includeArchived = input.include_archived === true || input.include_archived === 'true'
    const rows = await fetchAllRows<BudgetRow>(({ from, to }) => {
      let query = budgetsOf(ctx)
      if (input.fiscal_period_id) query = query.eq('fiscal_period_id', input.fiscal_period_id)
      if (!includeArchived) query = query.is('archived_at', null)
      return query.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
    })
    return { ok: true, data: { budgets: rows.map(toBudgetDto) } }
  } catch (error) {
    ctx.log.error('budget list failed', error as Error)
    return failed(error)
  }
}

export async function getBudget(
  ctx: OperationContext,
  input: GetBudgetInput,
): Promise<OperationOutcome<{ budget: BudgetDto; lines: BudgetLineDto[]; total_lines: number; has_more: boolean }>> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  const limit = input.limit ?? 1000
  const offset = input.offset ?? 0

  let query = ctx.supabase
    .from('budget_lines')
    .select('id, account_number, month, dimensions, amount', { count: 'exact' })
    .eq('company_id', ctx.companyId)
    .eq('budget_id', input.budget_id)
  if (input.account_number) query = query.eq('account_number', input.account_number)
  const { data, error, count } = await query
    .order('account_number', { ascending: true })
    .order('month', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) return failed(error)

  const lines = ((data ?? []) as { id: string; account_number: string; month: string; dimensions: Record<string, string>; amount: number | string }[]).map(
    (l) => ({
      budget_line_id: l.id,
      account_number: l.account_number,
      month: monthOf(l.month),
      dimensions: l.dimensions ?? {},
      amount: Number(l.amount),
    }),
  )
  const total = count ?? lines.length
  return {
    ok: true,
    data: { budget: toBudgetDto(loaded.budget), lines, total_lines: total, has_more: offset + lines.length < total },
  }
}

export async function createBudget(
  ctx: OperationContext,
  input: CreateBudgetInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ budget: BudgetDto }>> {
  const period = await loadPeriod(ctx, input.fiscal_period_id)
  if ('failure' in period) return period.failure

  const taken = await nameTaken(ctx, input.fiscal_period_id, input.name)
  if (typeof taken !== 'boolean') return taken
  if (taken) return { ok: false, code: 'BUDGET_NAME_TAKEN', details: { name: input.name } }

  let isDefault = input.is_default
  if (isDefault === undefined) {
    const { data, error } = await ctx.supabase
      .from('budgets')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('fiscal_period_id', input.fiscal_period_id)
      .eq('is_default', true)
      .limit(1)
    if (error) return failed(error)
    isDefault = (data ?? []).length === 0
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { fiscal_period_id: input.fiscal_period_id, fiscal_period_name: period.period.name, name: input.name, is_default: isDefault },
    }
  }

  const { data, error } = await ctx.supabase
    .from('budgets')
    .insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      fiscal_period_id: input.fiscal_period_id,
      name: input.name,
      is_default: isDefault,
    })
    .select('id, fiscal_period_id, name, is_default, archived_at, created_at, updated_at')
    .single()
  if (error) {
    if (isNameTaken(error)) return { ok: false, code: 'BUDGET_NAME_TAKEN', details: { name: input.name } }
    ctx.log.error('budget create failed', error)
    return failed(error)
  }
  return { ok: true, data: { budget: toBudgetDto(data as BudgetRow) }, created: true }
}

export async function updateBudget(
  ctx: OperationContext,
  input: UpdateBudgetInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ budget: BudgetDto }>> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  const budget = loaded.budget

  if (input.archived === true && input.is_default === true) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'is_default', message: 'An archived budget is never the default.' } }
  }
  const archivedAfter = input.archived ?? budget.archived_at !== null
  if (input.is_default === true && archivedAfter) {
    return { ok: false, code: 'BUDGET_ARCHIVED', details: { budget_id: budget.id } }
  }
  if (input.name !== undefined && input.name !== budget.name) {
    const taken = await nameTaken(ctx, budget.fiscal_period_id, input.name, budget.id)
    if (typeof taken !== 'boolean') return taken
    if (taken) return { ok: false, code: 'BUDGET_NAME_TAKEN', details: { name: input.name } }
  }

  // The budget as it will be: archiving takes the default away.
  const name = input.name ?? budget.name
  const isDefault = archivedAfter ? false : (input.is_default ?? budget.is_default)
  const archivedAt = !archivedAfter ? null : (budget.archived_at ?? new Date().toISOString())
  const unchanged = name === budget.name && isDefault === budget.is_default && archivedAt === budget.archived_at

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        budget_id: budget.id,
        name,
        is_default: isDefault,
        archived: archivedAfter,
      },
    }
  }

  if (unchanged) return { ok: true, data: { budget: toBudgetDto(budget) } }

  const { data, error } = await ctx.supabase
    .from('budgets')
    .update({ name, is_default: isDefault, archived_at: archivedAt })
    .eq('id', budget.id)
    .eq('company_id', ctx.companyId)
    .select('id, fiscal_period_id, name, is_default, archived_at, created_at, updated_at')
    .maybeSingle()
  if (error) {
    if (isNameTaken(error)) return { ok: false, code: 'BUDGET_NAME_TAKEN', details: { name: input.name } }
    ctx.log.error('budget update failed', error)
    return failed(error)
  }
  if (!data) return { ok: false, code: 'BUDGET_NOT_FOUND', details: { budget_id: budget.id } }
  return { ok: true, data: { budget: toBudgetDto(data as BudgetRow) } }
}

export async function deleteBudget(
  ctx: OperationContext,
  budgetId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ deleted: true; budget_id: string }>> {
  const loaded = await loadBudget(ctx, budgetId)
  if ('failure' in loaded) return loaded.failure

  if (options.dryRun) {
    const { count, error } = await ctx.supabase
      .from('budget_lines')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId)
      .eq('budget_id', budgetId)
    if (error) return failed(error)
    return {
      ok: true,
      dryRun: true,
      preview: { budget_id: budgetId, name: loaded.budget.name, line_count: count ?? 0 },
    }
  }

  const { error } = await ctx.supabase.from('budgets').delete().eq('id', budgetId).eq('company_id', ctx.companyId)
  if (error) {
    ctx.log.error('budget delete failed', error)
    return failed(error)
  }
  return { ok: true, data: { deleted: true, budget_id: budgetId } }
}

// ── Amounts ─────────────────────────────────────────────────────────────

interface SaveAnswer {
  ok: boolean
  code?: string
  inserted?: number
  updated?: number
  deleted?: number
  unchanged?: number
  [key: string]: unknown
}

/**
 * Every write of amounts, once the caller has found the budget in the
 * company: the atomic grid save (upsert_budget_lines) decides and writes; a
 * dry run asks its STABLE preview for the same refusals and counts. The
 * file import (lib/import/budget) saves a whole file through it in one call, so a file is
 * read in completely or not at all.
 */
export async function saveLines(
  ctx: OperationContext,
  budgetId: string,
  lines: readonly BudgetLineInput[],
  dryRun: boolean,
): Promise<{ counts: BudgetSaveCounts } | { failure: Failure }> {
  const { data, error } = await ctx.supabase.rpc(dryRun ? 'upsert_budget_lines_preview' : 'upsert_budget_lines', {
    p_budget_id: budgetId,
    p_lines: lines.map((l) => ({
      account_number: l.account_number,
      month: firstDayOf(l.month),
      dimensions: l.dimensions ?? {},
      amount: roundOre(l.amount),
    })),
  })
  if (error) {
    ctx.log.error('budget lines save failed', error)
    return { failure: failed(error) }
  }
  // A jsonb answer; a client may wrap it in an array.
  const answer = ((Array.isArray(data) ? data[0] : data) ?? {}) as SaveAnswer
  if (!answer.ok) {
    const details: Record<string, unknown> = { ...answer }
    delete details.ok
    delete details.code
    return { failure: { ok: false, code: answer.code ?? 'UNKNOWN_ERROR', details } }
  }
  return {
    counts: {
      budget_id: budgetId,
      inserted: Number(answer.inserted ?? 0),
      updated: Number(answer.updated ?? 0),
      deleted: Number(answer.deleted ?? 0),
      unchanged: Number(answer.unchanged ?? 0),
    },
  }
}

export async function upsertBudgetLines(
  ctx: OperationContext,
  input: UpsertBudgetLinesInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BudgetSaveCounts>> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  const saved = await saveLines(ctx, input.budget_id, input.lines, options.dryRun === true)
  if ('failure' in saved) return saved.failure
  if (options.dryRun) return { ok: true, dryRun: true, preview: { ...saved.counts } }
  return { ok: true, data: saved.counts }
}

/** Booked result per resultatkonto and month of a year, SIE sign ('YYYY-MM'). */
async function readActuals(
  ctx: OperationContext,
  periodId: string,
  window: { from?: string; to?: string },
  dimensions?: Record<string, string>,
): Promise<AccountMonthAmount[]> {
  const rows = await fetchAllRows<{ account_number: string; month: string; amount: number | string }>(({ from, to }) =>
    ctx.supabase
      .rpc('get_account_month_actuals', {
        p_company_id: ctx.companyId,
        p_fiscal_period_id: periodId,
        p_from: window.from ?? null,
        p_to: window.to ?? null,
        p_dimensions: dimensions && Object.keys(dimensions).length > 0 ? dimensions : null,
      })
      .order('account_number')
      .order('month')
      .range(from, to),
  )
  return rows.map((r) => ({ account_number: r.account_number, month: monthOf(r.month), amount: Number(r.amount) }))
}

export async function copyActualsToBudget(
  ctx: OperationContext,
  input: CopyActualsInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BudgetSaveCounts & { source_fiscal_period_id: string; accounts: string[] }>> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  if (loaded.budget.archived_at) return { ok: false, code: 'BUDGET_ARCHIVED', details: { budget_id: input.budget_id } }
  const period = await loadPeriod(ctx, loaded.budget.fiscal_period_id)
  if ('failure' in period) return period.failure
  const source = await loadSourcePeriod(ctx, period.period, input.source_fiscal_period_id)
  if ('failure' in source) return source.failure

  let actuals: AccountMonthAmount[]
  try {
    actuals = await readActuals(ctx, source.period.id, {}, input.dimensions)
  } catch (error) {
    ctx.log.error('budget actuals read failed', error as Error)
    return failed(error)
  }
  if (input.account_numbers) {
    const wanted = new Set(input.account_numbers)
    actuals = actuals.filter((a) => wanted.has(a.account_number))
  }

  const months = fiscalYearMonths(period.period.period_start, period.period.period_end)
  const cells = copyActualsToMonths(actuals, months, input.percent_change ?? 0)
  const accounts = [...new Set(cells.map((c) => c.account_number))]
  const lines: BudgetLineInput[] = cells.map((c) => ({ ...c, dimensions: input.dimensions }))

  const saved = await saveLines(ctx, input.budget_id, lines, options.dryRun === true)
  if ('failure' in saved) return saved.failure
  const result = { ...saved.counts, source_fiscal_period_id: source.period.id, accounts }
  if (options.dryRun) return { ok: true, dryRun: true, preview: result }
  return { ok: true, data: result }
}

export async function spreadBudget(
  ctx: OperationContext,
  input: SpreadInput,
  options: { dryRun?: boolean } = {},
): Promise<
  OperationOutcome<
    BudgetSaveCounts & { account_number: string; method: 'even' | 'last_year'; fell_back_to_even: boolean; months: MonthAmount[] }
  >
> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  if (loaded.budget.archived_at) return { ok: false, code: 'BUDGET_ARCHIVED', details: { budget_id: input.budget_id } }
  const period = await loadPeriod(ctx, loaded.budget.fiscal_period_id)
  if ('failure' in period) return period.failure
  const months = fiscalYearMonths(period.period.period_start, period.period.period_end)
  const method = input.method ?? 'even'

  let spread: MonthAmount[]
  let fellBack = false
  if (method === 'last_year') {
    const source = await loadSourcePeriod(ctx, period.period, input.source_fiscal_period_id)
    if ('failure' in source) return source.failure
    let actuals: AccountMonthAmount[]
    try {
      actuals = await readActuals(ctx, source.period.id, {}, input.dimensions)
    } catch (error) {
      ctx.log.error('budget actuals read failed', error as Error)
      return failed(error)
    }
    const profile = profileFromActuals(actuals.filter((a) => a.account_number === input.account_number))
    const result = spreadByProfile(input.amount, months, profile)
    spread = result.months
    fellBack = result.fellBackToEven
  } else {
    spread = spreadEvenly(input.amount, months)
  }

  const lines: BudgetLineInput[] = spread.map((m) => ({
    account_number: input.account_number,
    month: m.month,
    dimensions: input.dimensions,
    amount: m.amount,
  }))
  const saved = await saveLines(ctx, input.budget_id, lines, options.dryRun === true)
  if ('failure' in saved) return saved.failure
  const result = {
    ...saved.counts,
    account_number: input.account_number,
    method,
    fell_back_to_even: fellBack,
    months: spread,
  }
  if (options.dryRun) return { ok: true, dryRun: true, preview: result }
  return { ok: true, data: result }
}

// ── The dashboard grid ──────────────────────────────────────────────────

export type BudgetGridMode = 'untagged' | 'tag' | 'sum'

export interface BudgetGrid {
  budget: BudgetDto
  fiscal_period: { fiscal_period_id: string; name: string; period_start: string; period_end: string }
  /** The year's months, 'YYYY-MM'. */
  months: string[]
  mode: BudgetGridMode
  /** The tag the grid edits ({} untagged); null in the summed view. */
  dimensions: Record<string, string> | null
  /** False in the summed view and for an archived budget. */
  editable: boolean
  /** Whether any line carries a tag: the summed view is then the whole budget. */
  has_tagged_lines: boolean
  /** One row per account with an amount, amounts per month in the SIE sign. */
  rows: { account_number: string; account_name: string | null; amounts: number[] }[]
}

/**
 * The budget as the dashboard's account x month grid. The amounts are summed
 * in the database (get_budget_line_sums), so a budget per home answers one
 * row per account whichever view is shown: the lines of one exact tag
 * (editable), or all of them summed (read-only: a summed cell has no single
 * line to write to).
 */
export async function budgetGrid(ctx: OperationContext, input: BudgetGridInput): Promise<OperationOutcome<BudgetGrid>> {
  const loaded = await loadBudget(ctx, input.budget_id)
  if ('failure' in loaded) return loaded.failure
  const period = await loadPeriod(ctx, loaded.budget.fiscal_period_id)
  if ('failure' in period) return period.failure

  const { data: tagged, error: taggedError } = await ctx.supabase
    .from('budget_lines')
    .select('id')
    .eq('company_id', ctx.companyId)
    .eq('budget_id', input.budget_id)
    .neq('dimensions', '{}')
    .limit(1)
  if (taggedError) return failed(taggedError)
  const hasTagged = (tagged ?? []).length > 0

  const mode: BudgetGridMode = input.dim_no ? 'tag' : (input.mode ?? (hasTagged ? 'sum' : 'untagged'))
  const dimensions = mode === 'sum' ? null : mode === 'tag' ? { [input.dim_no!]: input.dim_code! } : {}
  const months = fiscalYearMonths(period.period.period_start, period.period.period_end)

  try {
    const sums = await readBudgetSums(ctx.supabase, ctx.companyId, input.budget_id, {
      ...(dimensions ? { dimensions, exact: true } : {}),
    })
    const byAccount = new Map<string, number[]>()
    for (const s of sums) {
      const i = s.month ? months.indexOf(s.month) : -1
      if (i === -1) continue
      const amounts = byAccount.get(s.account_number) ?? months.map(() => 0)
      amounts[i] = roundOre(amounts[i]! + s.amount)
      byAccount.set(s.account_number, amounts)
    }
    const accounts = [...byAccount.keys()].sort()
    const names = new Map<string, string>()
    if (accounts.length > 0) {
      const { data, error } = await ctx.supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('company_id', ctx.companyId)
        .in('account_number', accounts)
      if (error) return failed(error)
      for (const a of (data ?? []) as { account_number: string; account_name: string }[]) names.set(a.account_number, a.account_name)
    }
    return {
      ok: true,
      data: {
        budget: toBudgetDto(loaded.budget),
        fiscal_period: {
          fiscal_period_id: period.period.id,
          name: period.period.name,
          period_start: period.period.period_start,
          period_end: period.period.period_end,
        },
        months,
        mode,
        dimensions,
        editable: mode !== 'sum' && loaded.budget.archived_at === null,
        has_tagged_lines: hasTagged,
        rows: accounts.map((account_number) => ({
          account_number,
          account_name: names.get(account_number) ?? null,
          amounts: byAccount.get(account_number)!,
        })),
      },
    }
  } catch (error) {
    ctx.log.error('budget grid read failed', error as Error)
    return failed(error)
  }
}

// ── Budget against actual ───────────────────────────────────────────────

export type BudgetVsActualReport = BudgetVsActualTable & {
  budget: BudgetDto
  fiscal_period: { fiscal_period_id: string; name: string; period_start: string; period_end: string }
  from_month: string
  to_month: string
  dimension_filter: Record<string, string> | null
}

export async function budgetVsActual(
  ctx: OperationContext,
  input: BudgetVsActualInput,
): Promise<OperationOutcome<BudgetVsActualReport>> {
  let budget: BudgetRow
  if (input.budget_id) {
    const loaded = await loadBudget(ctx, input.budget_id)
    if ('failure' in loaded) return loaded.failure
    budget = loaded.budget
    if (input.fiscal_period_id && input.fiscal_period_id !== budget.fiscal_period_id) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        details: { field: 'fiscal_period_id', message: 'The budget belongs to another fiscal year.' },
      }
    }
  } else {
    const period = await loadPeriod(ctx, input.fiscal_period_id!)
    if ('failure' in period) return period.failure
    const { data, error } = await budgetsOf(ctx)
      .eq('fiscal_period_id', input.fiscal_period_id!)
      .eq('is_default', true)
      .maybeSingle()
    if (error) return failed(error)
    if (!data) return { ok: false, code: 'BUDGET_NONE_FOR_YEAR', details: { fiscal_period_id: input.fiscal_period_id } }
    budget = data as BudgetRow
  }

  const period = await loadPeriod(ctx, budget.fiscal_period_id)
  if ('failure' in period) return period.failure
  const yearMonths = fiscalYearMonths(period.period.period_start, period.period.period_end)
  const fromMonth = input.from_month ?? yearMonths[0]!
  const toMonth = input.to_month ?? yearMonths[yearMonths.length - 1]!
  const outside = [fromMonth, toMonth].filter((m) => !yearMonths.includes(m))
  if (outside.length > 0) {
    return {
      ok: false,
      code: 'BUDGET_MONTH_OUTSIDE_YEAR',
      details: { months: outside, period_start: period.period.period_start, period_end: period.period.period_end },
    }
  }
  const months = monthsBetween(fromMonth, toMonth)
  const dimensions = input.dim_no && input.dim_code ? { [input.dim_no]: input.dim_code } : undefined

  try {
    const [actual, budgetLines, accounts] = await Promise.all([
      readActuals(ctx, period.period.id, { from: firstDayOf(fromMonth), to: lastDayOf(toMonth) }, dimensions),
      // Summed in the database: a budget per home is accounts x months x
      // homes lines, and the table needs one figure per account and month.
      readBudgetSums(ctx.supabase, ctx.companyId, budget.id, { fromMonth, toMonth, dimensions }),
      fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
        ctx.supabase
          .from('chart_of_accounts')
          .select('account_number, account_name')
          .eq('company_id', ctx.companyId)
          .gte('account_number', RESULTATKONTO_FIRST)
          .lte('account_number', RESULTATKONTO_LAST)
          .order('account_number')
          .range(from, to),
      ),
    ])

    const table = computeBudgetVsActual({
      months,
      budget: budgetLines.map((l) => ({ account_number: l.account_number, month: l.month!, amount: l.amount })),
      actual,
      accountNames: new Map(accounts.map((a) => [a.account_number, a.account_name])),
    })
    return {
      ok: true,
      data: {
        budget: toBudgetDto(budget),
        fiscal_period: {
          fiscal_period_id: period.period.id,
          name: period.period.name,
          period_start: period.period.period_start,
          period_end: period.period.period_end,
        },
        from_month: fromMonth,
        to_month: toMonth,
        dimension_filter: dimensions ?? null,
        ...table,
      },
    }
  } catch (error) {
    ctx.log.error('budget vs actual failed', error as Error)
    return failed(error)
  }
}
