/**
 * The K2/K3 framework a räkenskapsår is prepared under (BFNAR 2012:4).
 *
 * The framework is stored per fiscal year in `fiscal_period_frameworks`
 * (migration 20261030040201): one row per year, written when the year is
 * created (it follows the year before, else the company default) and by
 * `set_fiscal_period_framework` (lib/company/accounting-framework-change.ts).
 * `companies.accounting_framework` is only the default for the next new year;
 * reading it for a given year is the bug this module replaces, because a
 * switch then rewrote every earlier year's årsredovisning.
 *
 * Every reader asks here:
 *   - resolveAccountingFramework(supabase, companyId, fiscalPeriodId): the
 *     framework of one year (the årsredovisning, the year-end, INK2, iXBRL);
 *   - resolveCurrentAccountingFramework(supabase, companyId): the framework of
 *     the year running today (asset defaults, settings, anything without a
 *     year of its own);
 *   - getFiscalPeriodFramework: the row with its source and the K3 to K2
 *     switch reasons, for the switch note and the first-K3-year check.
 *
 * A missing row (a year created before the migration ran in that database)
 * falls back to the company default, which is what every reader used before.
 * A read error throws: a guessed framework would build the wrong document.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountingFramework } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

/**
 * How reliable a stored framework is:
 *   - company_default: copied from the company setting (the backfill for a
 *     year without a locked årsredovisning, a year created with no previous
 *     year, or one that followed a year that was itself a default). What the
 *     product used for the year, not proof of the framework its
 *     årsredovisning was prepared under.
 *   - annual_report: the framework of the year's locked årsredovisning
 *     version (the backfill): what the year was prepared under.
 *   - previous_year: followed a previous year whose value was reliable, when
 *     the year was created, or by a cascade from an election on an earlier year.
 *   - election: chosen for this year.
 *   - company_fallback: no row exists; the company setting stands in.
 */
export type AccountingFrameworkSource =
  | 'company_default'
  | 'annual_report'
  | 'previous_year'
  | 'election'
  | 'company_fallback'

/**
 * Whether a stored framework can be relied on as the one the year's
 * årsredovisning was prepared under. A company default (or the fallback)
 * cannot: the K3 to K2 switch and the first-K3-year check ask the user then.
 * The same rule as set_fiscal_period_framework (migration 20261030040201).
 */
export function isReliableFrameworkSource(source: AccountingFrameworkSource | null | undefined): boolean {
  return source === 'election' || source === 'annual_report' || source === 'previous_year'
}

export interface FiscalPeriodFramework {
  fiscal_period_id: string
  framework: AccountingFramework
  source: AccountingFrameworkSource
  /** The framework the year carried before its latest election. */
  previous_framework: AccountingFramework | null
  /** BFNAR 2012:4 punkt 3: the reasons for a switch from K3 to K2 (K2 years only). */
  change_reason: string | null
  previously_applied_k2: boolean | null
  special_reasons_confirmed: boolean | null
  /** The previous årsredovisning's framework as the user stated it at the election, when no reliable record existed. */
  stated_previous_year_framework: AccountingFramework | 'none' | null
  decided_at: string | null
}

function asStatedFramework(value: unknown): AccountingFramework | 'none' | null {
  return value === 'none' ? 'none' : asFramework(value)
}

function asFramework(value: unknown): AccountingFramework | null {
  return value === 'k2' || value === 'k3' ? value : null
}

/** The company default: the framework of the latest year, used for a year with no row. */
export async function companyDefaultFramework(
  supabase: SupabaseClient,
  companyId: string,
): Promise<AccountingFramework> {
  const { data, error } = await supabase
    .from('companies')
    .select('accounting_framework')
    .eq('id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the company's accounting framework: ${error.message}`)
  // The column is NOT NULL DEFAULT 'k2'; a missing company reads as K2, as
  // every reader did before the per-year value existed.
  return asFramework((data as { accounting_framework?: unknown } | null)?.accounting_framework) ?? 'k2'
}

/** The stored row for one fiscal year, or the company default when there is none. */
export async function getFiscalPeriodFramework(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<FiscalPeriodFramework> {
  const { data, error } = await supabase
    .from('fiscal_period_frameworks')
    .select(
      'fiscal_period_id, framework, source, previous_framework, change_reason, previously_applied_k2, special_reasons_confirmed, stated_previous_year_framework, decided_at',
    )
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the fiscal year's accounting framework: ${error.message}`)
  const row = data as Record<string, unknown> | null
  const framework = asFramework(row?.framework)
  if (row && framework) {
    return {
      fiscal_period_id: fiscalPeriodId,
      framework,
      source: (row.source as AccountingFrameworkSource) ?? 'company_default',
      previous_framework: asFramework(row.previous_framework),
      change_reason: typeof row.change_reason === 'string' ? row.change_reason : null,
      previously_applied_k2: typeof row.previously_applied_k2 === 'boolean' ? row.previously_applied_k2 : null,
      special_reasons_confirmed:
        typeof row.special_reasons_confirmed === 'boolean' ? row.special_reasons_confirmed : null,
      stated_previous_year_framework: asStatedFramework(row.stated_previous_year_framework),
      decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
    }
  }
  return {
    fiscal_period_id: fiscalPeriodId,
    framework: await companyDefaultFramework(supabase, companyId),
    source: 'company_fallback',
    previous_framework: null,
    change_reason: null,
    previously_applied_k2: null,
    special_reasons_confirmed: null,
    stated_previous_year_framework: null,
    decided_at: null,
  }
}

/** The framework one räkenskapsår is prepared under. */
export async function resolveAccountingFramework(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<AccountingFramework> {
  return (await getFiscalPeriodFramework(supabase, companyId, fiscalPeriodId)).framework
}

export interface FiscalYearRef {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

/**
 * The year a framework change made without naming one applies to: the year
 * running on `todayIso`, else the latest year that has started, else the
 * earliest one. Null when the company has no fiscal years.
 */
export function pickCurrentFiscalYear<T extends Pick<FiscalYearRef, 'period_start' | 'period_end'>>(
  years: readonly T[],
  todayIso: string,
): T | null {
  if (years.length === 0) return null
  const sorted = [...years].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const running = sorted.find((y) => y.period_start <= todayIso && todayIso <= y.period_end)
  if (running) return running
  const started = sorted.filter((y) => y.period_start <= todayIso)
  return started.length > 0 ? started[started.length - 1] : sorted[0]
}

/** The company's fiscal years, oldest first. */
export async function listFiscalYears(supabase: SupabaseClient, companyId: string): Promise<FiscalYearRef[]> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, is_closed, locked_at')
    .eq('company_id', companyId)
    .order('period_start', { ascending: true })
  if (error) throw new Error(`Failed to load fiscal years: ${error.message}`)
  return ((data ?? []) as FiscalYearRef[]).map((y) => ({ ...y, is_closed: Boolean(y.is_closed) }))
}

/**
 * The framework of the year running today (or `todayIso`), for readers with
 * no year of their own. With no fiscal years the company default.
 */
export async function resolveCurrentAccountingFramework(
  supabase: SupabaseClient,
  companyId: string,
  todayIso: string = todayIsoStockholm(),
): Promise<AccountingFramework> {
  const year = pickCurrentFiscalYear(await listFiscalYears(supabase, companyId), todayIso)
  if (!year) return companyDefaultFramework(supabase, companyId)
  return resolveAccountingFramework(supabase, companyId, year.id)
}

export interface FiscalYearFramework extends FiscalYearRef {
  framework: AccountingFramework
  source: AccountingFrameworkSource
  change_reason: string | null
}

/** Every fiscal year with its framework, oldest first (the settings list). */
export async function listFiscalYearFrameworks(
  supabase: SupabaseClient,
  companyId: string,
): Promise<FiscalYearFramework[]> {
  const [years, rowsResult, fallback] = await Promise.all([
    listFiscalYears(supabase, companyId),
    supabase
      .from('fiscal_period_frameworks')
      .select('fiscal_period_id, framework, source, change_reason')
      .eq('company_id', companyId),
    companyDefaultFramework(supabase, companyId),
  ])
  if (rowsResult.error) {
    throw new Error(`Failed to load the fiscal years' accounting frameworks: ${rowsResult.error.message}`)
  }
  const byPeriod = new Map(
    ((rowsResult.data ?? []) as Array<{
      fiscal_period_id: string
      framework: string
      source: AccountingFrameworkSource
      change_reason: string | null
    }>).map((row) => [row.fiscal_period_id, row]),
  )
  return years.map((year) => {
    const row = byPeriod.get(year.id)
    const framework = asFramework(row?.framework)
    return {
      ...year,
      framework: framework ?? fallback,
      source: framework ? row!.source : 'company_fallback',
      change_reason: framework ? row!.change_reason ?? null : null,
    }
  })
}

export interface PreviousYearFramework {
  /** The adjacent previous year (ends the day before this one starts), if Accounted holds it. */
  fiscal_period_id: string | null
  framework: AccountingFramework | null
  source: AccountingFrameworkSource | null
  /**
   * True when the stored value can be relied on as the framework that year
   * was prepared under: an election, its locked årsredovisning, or a year
   * that followed a reliable year (isReliableFrameworkSource). A company
   * default is not.
   */
  reliable: boolean
}

function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/**
 * The framework of the year before `periodStart`, for the first-K3-year check
 * (K3 kap. 35) and the K3 to K2 switch note. Null fields when Accounted holds
 * no adjacent previous year.
 */
export async function getPreviousYearFramework(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string },
): Promise<PreviousYearFramework> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_end', dayBefore(period.period_start))
    .neq('id', period.id)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the previous fiscal year: ${error.message}`)
  return previousYearFrameworkOf(supabase, companyId, (data as { id: string } | null)?.id ?? null)
}

/**
 * The framework record of a known previous year (a caller that already
 * picked the adjacent year, build-data.ts), null fields without one.
 */
export async function previousYearFrameworkOf(
  supabase: SupabaseClient,
  companyId: string,
  previousId: string | null,
): Promise<PreviousYearFramework> {
  if (!previousId) return { fiscal_period_id: null, framework: null, source: null, reliable: false }
  const row = await getFiscalPeriodFramework(supabase, companyId, previousId)
  return {
    fiscal_period_id: previousId,
    framework: row.framework,
    source: row.source,
    reliable: isReliableFrameworkSource(row.source),
  }
}

/**
 * The framework of the fiscal year a day falls in, for an action that
 * belongs to a day rather than a year: an asset registered as acquired on
 * it (K3 components, own development, the Ej K2 accounts). A day outside
 * every fiscal year reads the year running today
 * (resolveCurrentAccountingFramework). The SQL side reads the same rule
 * through public.fiscal_framework_on.
 */
export async function frameworkOnDate(
  supabase: SupabaseClient,
  companyId: string,
  day: string | null | undefined,
): Promise<AccountingFramework> {
  if (day) {
    const { data, error } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lte('period_start', day)
      .gte('period_end', day)
      .order('period_start', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(`Kunde inte läsa räkenskapsåret: ${error.message}`)
    const id = (data as { id?: string } | null)?.id
    if (id) return resolveAccountingFramework(supabase, companyId, id)
  }
  return resolveCurrentAccountingFramework(supabase, companyId)
}
