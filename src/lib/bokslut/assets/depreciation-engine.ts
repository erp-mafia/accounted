import type { SupabaseClient } from '@supabase/supabase-js'
import { AssetDepreciationRefusedError } from '@/lib/bookkeeping/errors'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type {
  Asset,
  FiscalPeriod,
  JournalEntry,
  CreateJournalEntryLineInput,
} from '@/types'

export interface AssetDepreciation {
  asset: Asset
  /** Planenlig avskrivning för denna period, avrundad till hela kronor. */
  amount: number
  /** Net book value vid periodens slut (ackumulerad avskrivning inklusive
   *  denna period subtraherat från anskaffningsvärdet). Används av wizard
   *  UI:t för att visa restvärde efter avskrivning. */
  netBookValueAfter: number
  /** True om avskrivningen pro-rateras (tillgång anskaffad eller fullt
   *  avskriven mitt i perioden). */
  proRated: boolean
  /** Befintligt depreciation_schedules-id om en proposal redan finns för
   *  denna kombination. Wizard:t använder detta för att veta att proposalen
   *  redan har bokförts (om journal_entry_id är satt) eller är väntande
   *  (om journal_entry_id är null). */
  existingScheduleId?: string
  existingJournalEntryId?: string | null
}

export interface DepreciationProposal {
  fiscalPeriod: { id: string; name: string; period_start: string; period_end: string }
  items: AssetDepreciation[]
  totalAmount: number
}

/**
 * Planenlig avskrivning Accounted posted for an asset in one earlier fiscal
 * period: the period's dates and the posted (journal-linked) amount.
 */
export interface PostedDepreciationPeriod {
  period_start: string
  period_end: string
  amount: number
}

/**
 * Depreciation booked IN ACCOUNTED for the asset before the period, as the
 * engine is told it. The opening balance from a previous system is never in
 * here: it is read from the asset itself.
 *
 * - The posted periods (preferred). The engine then knows whether the posted
 *   history is the plan that the asset's current useful life and salvage
 *   value give. When it is not (the life or salvage value was changed after
 *   depreciation was posted), what is left is spread over the remaining life
 *   from the period start: a changed estimate is applied prospectively. When
 *   the register holds the whole history, the period that reaches the end
 *   of the life takes exactly what is left.
 * - A bare total (older callers). The charge is capped at what is left, but
 *   without the periods the engine cannot tell a changed estimate from
 *   history that is missing from the register, so it neither re-plans nor
 *   trues up the final period (the opening path keeps its own true-up).
 */
export type PriorDepreciation = number | readonly PostedDepreciationPeriod[]

/**
 * Compute avskrivning för en enskild tillgång under en given fiscal period.
 *
 * Ordinary depreciation is always linear at asset level and pro-rates by the
 * active-life overlap, scaled by the fiscal year's length (see
 * fiscalYearLengthFactor). The pooled 30, 20 and 25 percent tax rules live in
 * tax-depreciation.ts and never create ordinary per-asset postings.
 */
export function computeAnnualDepreciation(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  /** Depreciation booked in Accounted for this asset before this period:
   *  the posted periods, or (older callers) their total. See
   *  PriorDepreciation. */
  prior: PriorDepreciation = 0,
): { amount: number; proRated: boolean } {
  if (asset.disposed_at && asset.disposed_at < fiscalPeriod.period_start) {
    return { amount: 0, proRated: false }
  }

  // K3 component approach (BFNAR 2012:1 ch.17.4) overrides the method-based
  // dispatch entirely. When non-null and non-empty, each component is
  // depreciated linearly on its own life (with the same pro-ration logic
  // as the asset-level linear method) and the per-component amounts are
  // summed. The asset's `depreciation_method` and `salvage_value` are
  // ignored: components carry their own salvage_value and life.
  if (Array.isArray(asset.k3_components) && asset.k3_components.length > 0) {
    const result = computeComponentDepreciation(asset, fiscalPeriod)
    return { amount: result.amount, proRated: result.proRated }
  }

  const opening = openingDepreciationOf(asset)
  const plan = opening ? linearPlanFromOpening(asset, opening) : linearPlan(asset)
  return settleLinear(plan, asset, fiscalPeriod, prior)
}

/**
 * The total depreciation booked in Accounted before the period, from either
 * form of PriorDepreciation. Posted periods that do not end before the
 * period starts are not before it and are left out.
 */
export function priorDepreciationTotal(prior: PriorDepreciation, periodStart: string): number {
  if (!isPostedHistory(prior)) return roundOre(Number(prior) || 0)
  return roundOre(
    postedBefore(prior, periodStart).reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
  )
}

/**
 * The posted history in the form the engine wants, from posted
 * depreciation_schedules rows and the company's fiscal periods. Unposted
 * rows are skipped. Null when a posted row's period is unknown: the caller
 * then passes the bare total instead.
 */
export function postedDepreciationHistory(
  rows: ReadonlyArray<{
    fiscal_period_id: string
    planned_depreciation: number | string
    journal_entry_id?: string | null
  }>,
  periods: ReadonlyArray<{ id: string; period_start: string; period_end: string }>,
): PostedDepreciationPeriod[] | null {
  const byId = new Map(periods.map((period) => [period.id, period]))
  const history: PostedDepreciationPeriod[] = []
  for (const row of rows) {
    if (row.journal_entry_id === null) continue
    const period = byId.get(row.fiscal_period_id)
    if (!period) return null
    history.push({
      period_start: period.period_start,
      period_end: period.period_end,
      amount: Number(row.planned_depreciation) || 0,
    })
  }
  return history
}

export interface OpeningDepreciation {
  /** Ackumulerad avskrivning already on the books, in SEK (öre-rounded). */
  amount: number
  /** ISO date the amount is stated per (inclusive). */
  date: string
}

/**
 * The asset's opening accumulated depreciation (depreciation booked in a
 * previous system before the asset entered Accounted), or null when there is
 * none. It is part of the accumulated depreciation on the books but was never
 * posted by Accounted, so every place that sums posted schedules must add it.
 */
export function openingDepreciationOf(asset: Asset): OpeningDepreciation | null {
  const amount = roundOre(Number(asset.opening_accumulated_depreciation ?? 0) || 0)
  const date = asset.opening_depreciation_date ?? null
  if (amount <= 0 || !date) return null
  return { amount, date }
}

/** One period's charge under a linear plan, before any cap. */
interface PlanCharge {
  /** Whole kronor. */
  amount: number
  proRated: boolean
  /** The period runs to the last day of the useful life. */
  reachesLifeEnd: boolean
}

/**
 * A linear depreciation plan for one asset (the non-component paths). It
 * spreads `depreciable` from `start` to the end of the useful life; `charge`
 * gives one period's whole-krona amount, pro-rated and scaled by the fiscal
 * year's length, before any cap at what is left.
 */
interface LinearPlan {
  /** Öre-rounded amount the plan spreads: cost less salvage, less any opening amount. */
  depreciable: number
  /** First day the plan depreciates. */
  start: Date
  lifeEndExclusive: Date
  /** The opening path trues up its final period from the opening anchor
   *  whatever Accounted knows about the periods in between, as before. */
  anchored: boolean
  charge(fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>): PlanCharge | null
}

/**
 * The original plan: (cost - salvage) x 12 / useful life a year from the
 * acquisition date. The arithmetic is kept exactly as it was, so an asset
 * whose estimates never changed gets the same amounts as before.
 */
function linearPlan(asset: Asset): LinearPlan | null {
  const acquisitionCost = Number(asset.acquisition_cost)
  const salvageValue = Number(asset.salvage_value)
  const depreciableBase = acquisitionCost - salvageValue
  if (depreciableBase <= 0) return null

  const usefulLifeMonths = asset.useful_life_months
  const annualRate = 12 / usefulLifeMonths
  const acquisition = isoToDate(asset.acquisition_date)
  const lifeEndExclusive = addMonths(acquisition, usefulLifeMonths)

  return {
    depreciable: roundOre(depreciableBase),
    start: acquisition,
    lifeEndExclusive,
    anchored: false,
    charge(fiscalPeriod) {
      const window = lifeWindow(asset, fiscalPeriod, acquisition, lifeEndExclusive)
      if (!window) return null
      // Full-year amount = annualRate × depreciableBase (linear), for 12 months.
      const annualAmount = depreciableBase * annualRate
      const proRatedAmount = annualAmount * window.fraction * window.yearLength
      return {
        amount: Math.round(proRatedAmount),
        proRated: window.proRated,
        reachesLifeEnd: window.reachesLifeEnd,
      }
    },
  }
}

/**
 * Linear planenlig avskrivning for an asset that arrived partly depreciated.
 *
 * The remaining depreciable amount (cost - salvage - opening accumulated
 * depreciation) is spread linearly over the remaining useful life, which
 * runs from the day after the opening date to the end of the original life
 * (acquisition_date + useful_life_months). Depreciation for periods on or
 * before the opening date is 0: it is already in the opening amount.
 *
 * When the previous system followed the same linear plan this reproduces
 * the original schedule exactly (the remaining amount over the remaining
 * months is the original annual rate). When it did not, the plan continues
 * from the actual book value, so the asset is fully depreciated exactly when
 * the life ends and never below its salvage value.
 */
function linearPlanFromOpening(asset: Asset, opening: OpeningDepreciation): LinearPlan | null {
  const acquisitionCost = Number(asset.acquisition_cost)
  const salvageValue = Number(asset.salvage_value)
  const remainingBase = roundOre(acquisitionCost - salvageValue - opening.amount)
  if (remainingBase <= 0) return null

  const acquisition = isoToDate(asset.acquisition_date)
  const lifeEndExclusive = addMonths(acquisition, asset.useful_life_months)
  const remainingStart = maxDate(addDays(isoToDate(opening.date), 1), acquisition)
  const remainingMonths = fractionalMonthsBetween(remainingStart, lifeEndExclusive)

  return {
    depreciable: remainingBase,
    start: remainingStart,
    lifeEndExclusive,
    anchored: true,
    charge(fiscalPeriod) {
      // A life that ended on or before the opening date leaves nothing to plan.
      if (remainingMonths <= 0) return null
      const window = lifeWindow(asset, fiscalPeriod, remainingStart, lifeEndExclusive)
      if (!window) return null
      const annualAmount = (remainingBase * 12) / remainingMonths
      return {
        amount: Math.round(annualAmount * window.fraction * window.yearLength),
        proRated: window.proRated,
        reachesLifeEnd: window.reachesLifeEnd,
      }
    },
  }
}

/**
 * The overlap between the period and the asset's life from `start` (cut at
 * the disposal date) as a share of the period's days, with the period's
 * length factor. Null when they do not overlap.
 */
function lifeWindow(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  start: Date,
  lifeEndExclusive: Date,
): { fraction: number; proRated: boolean; yearLength: number; reachesLifeEnd: boolean } | null {
  const periodStart = isoToDate(fiscalPeriod.period_start)
  const periodEndInclusive = isoToDate(fiscalPeriod.period_end)
  const disposalEnd = asset.disposed_at ? isoToDate(asset.disposed_at) : null
  const lastLifeDay = addDays(lifeEndExclusive, -1)

  const windowStart = maxDate(start, periodStart)
  let windowEnd = minDate(periodEndInclusive, lastLifeDay)
  if (disposalEnd) windowEnd = minDate(windowEnd, disposalEnd)
  if (windowEnd < windowStart) return null

  const fullPeriodDays = daysBetween(periodStart, periodEndInclusive) + 1
  const windowDays = daysBetween(windowStart, windowEnd) + 1
  const fraction = windowDays / fullPeriodDays
  return {
    fraction,
    proRated: fraction < 0.999,
    yearLength: fiscalYearLengthFactor(periodStart, periodEndInclusive),
    reachesLifeEnd: windowEnd >= lastLifeDay,
  }
}

/**
 * The period's charge under the plan, settled against what Accounted has
 * already booked:
 *
 * 1. Never more than is left (cost - salvage - opening - posted), so the
 *    asset is never depreciated below its salvage value.
 * 2. When the posted periods are known, cover the plan from its start
 *    without a gap, and differ from what the plan gives for those periods,
 *    an estimate (useful life or salvage value) was changed after posting.
 *    The change applies "framåt i tiden" (K3 10.9; K2 10.26 and its
 *    kommentar): what is left is spread over the remaining life from this
 *    period's start (see replan).
 * 3. The period that reaches the end of the life takes exactly what is left,
 *    so whole-krona rounding neither strands nor adds kronor. On the plain
 *    path only when the register holds the whole history: otherwise "what
 *    is left" would include years booked before Accounted that the register
 *    does not know about.
 */
function settleLinear(
  plan: LinearPlan | null,
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  prior: PriorDepreciation,
): { amount: number; proRated: boolean } {
  if (!plan) return { amount: 0, proRated: false }

  const history = isPostedHistory(prior) ? postedBefore(prior, fiscalPeriod.period_start) : null
  const left = roundOre(plan.depreciable - priorDepreciationTotal(prior, fiscalPeriod.period_start))
  const complete = history !== null && coversPlan(history, plan.start, fiscalPeriod)

  if (complete && history.length > 0 && !followsPlan(plan, history)) {
    return replan(plan, asset, fiscalPeriod, left)
  }

  const charge = plan.charge(fiscalPeriod)
  if (!charge) return { amount: 0, proRated: false }
  if (left <= 0) return { amount: 0, proRated: charge.proRated }

  const trueUp = charge.reachesLifeEnd && (plan.anchored || complete)
  return {
    amount: roundOre(trueUp ? left : Math.min(charge.amount, left)),
    proRated: charge.proRated,
  }
}

/**
 * A changed estimate, applied prospectively: what is left is spread linearly
 * over the remaining life from the period start, with the same pro-ration
 * and fiscal-year-length scaling as the plan, and the period that reaches
 * the end of the life takes exactly what is left. A life that now ends
 * before the period starts leaves its whole remaining amount to this period.
 */
function replan(
  plan: LinearPlan,
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  left: number,
): { amount: number; proRated: boolean } {
  if (left <= 0) return { amount: 0, proRated: false }

  const from = maxDate(plan.start, isoToDate(fiscalPeriod.period_start))
  const remainingMonths = fractionalMonthsBetween(from, plan.lifeEndExclusive)
  if (remainingMonths <= 0) return { amount: left, proRated: false }

  const window = lifeWindow(asset, fiscalPeriod, from, plan.lifeEndExclusive)
  if (!window) return { amount: 0, proRated: false }
  const planned = Math.round(((left * 12) / remainingMonths) * window.fraction * window.yearLength)
  return {
    amount: roundOre(window.reachesLifeEnd ? left : Math.min(planned, left)),
    proRated: window.proRated,
  }
}

function isPostedHistory(prior: PriorDepreciation): prior is readonly PostedDepreciationPeriod[] {
  return Array.isArray(prior)
}

/** Posted periods that end before `periodStart`, in date order. */
function postedBefore(
  history: readonly PostedDepreciationPeriod[],
  periodStart: string,
): PostedDepreciationPeriod[] {
  return history
    .filter((row) => row.period_end < periodStart)
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
}

/**
 * True when the posted periods run without a gap from the period holding the
 * plan's first day to the day before `fiscalPeriod` starts: the register
 * then holds the asset's whole depreciation history. With nothing posted,
 * true when the plan starts in this period. Compared as time values, so an
 * unparseable date answers false instead of throwing.
 */
function coversPlan(
  history: readonly PostedDepreciationPeriod[],
  planStart: Date,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
): boolean {
  const start = planStart.getTime()
  const periodStart = isoToDate(fiscalPeriod.period_start).getTime()
  if (history.length === 0) return start >= periodStart
  const first = history[0]
  if (!(isoToDate(first.period_start).getTime() <= start && start <= isoToDate(first.period_end).getTime())) {
    return false
  }
  const dayAfter = (iso: string) => addDays(isoToDate(iso), 1).getTime()
  for (let i = 1; i < history.length; i += 1) {
    if (isoToDate(history[i].period_start).getTime() !== dayAfter(history[i - 1].period_end)) return false
  }
  return dayAfter(history[history.length - 1].period_end) === periodStart
}

/**
 * True when what was posted equals what the plan, as the asset now stands,
 * gives for the same periods (before any cap or true-up). False means the
 * useful life or salvage value changed after depreciation was posted.
 */
function followsPlan(plan: LinearPlan, history: readonly PostedDepreciationPeriod[]): boolean {
  let planned = 0
  let posted = 0
  for (const row of history) {
    planned += plan.charge(row)?.amount ?? 0
    posted += Number(row.amount) || 0
  }
  return Math.abs(roundOre(planned) - roundOre(posted)) < 0.005
}

export interface ComponentDepreciationResult {
  /** Sum of per-component depreciation, rounded to whole kronor. */
  amount: number
  /** True if any component was pro-rated (mid-year acquisition or disposal). */
  proRated: boolean
  /** Per-component breakdown: names mirror `asset.k3_components[*].name`.
   *  Each amount is rounded to whole kronor; the total `amount` is the sum
   *  of these rounded values (so the breakdown reconciles exactly with the
   *  total: no hidden öre). */
  perComponent: { name: string; amount: number }[]
}

/**
 * Compute component depreciation for a K3 asset (BFNAR 2012:1 ch.17.4).
 *
 * Mirrors `computeLinearAnnual` per component: the depreciable base is
 * `cost − salvage_value` (salvage defaults to 0 when omitted), and the
 * annual amount is `depreciableBase × 12 / useful_life_months`, scaled by
 * the fiscal year's length like every other path. The pro-ration window is
 * the overlap between the period and the asset's active life: components
 * share the same acquisition_date and disposal date as the parent asset,
 * because BFNAR 2012:1 treats them as a single
 * accounting unit for acquisition / disposal purposes; only the depreciation
 * schedule is split.
 *
 * Per-component amounts are rounded to whole kronor individually, then
 * summed, so the breakdown returned by this function reconciles exactly
 * with `amount`. This matches the linear / declining methods which also
 * round at the per-asset level.
 */
export function computeComponentDepreciation(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
): ComponentDepreciationResult {
  const components = asset.k3_components ?? []
  if (components.length === 0) {
    return { amount: 0, proRated: false, perComponent: [] }
  }

  // Pre-compute the period vs life window so each component shares the
  // same date math (acquisition_date and disposal date are asset-level).
  const acquisition = isoToDate(asset.acquisition_date)
  const periodStart = isoToDate(fiscalPeriod.period_start)
  const periodEndInclusive = isoToDate(fiscalPeriod.period_end)
  const disposalEnd = asset.disposed_at ? isoToDate(asset.disposed_at) : null
  const fullPeriodDays = daysBetween(periodStart, periodEndInclusive) + 1
  const yearLength = fiscalYearLengthFactor(periodStart, periodEndInclusive)

  const perComponent: { name: string; amount: number }[] = []
  let total = 0
  let anyProRated = false

  for (const [index, component] of components.entries()) {
    const label = component.name?.trim() || `Komponent ${index + 1}`
    const cost = Number(component.cost)
    const salvage = Number(component.salvage_value ?? 0)
    const depreciableBase = cost - salvage
    if (depreciableBase <= 0 || component.useful_life_months <= 0) {
      perComponent.push({ name: label, amount: 0 })
      continue
    }

    const annualRate = 12 / component.useful_life_months
    const lifeEndExclusive = addMonths(acquisition, component.useful_life_months)

    const windowStart = maxDate(acquisition, periodStart)
    let windowEnd = minDate(periodEndInclusive, addDays(lifeEndExclusive, -1))
    if (disposalEnd) windowEnd = minDate(windowEnd, disposalEnd)

    if (windowEnd < windowStart) {
      perComponent.push({ name: label, amount: 0 })
      continue
    }

    const windowDays = daysBetween(windowStart, windowEnd) + 1
    const fraction = windowDays / fullPeriodDays
    if (fraction < 0.999) anyProRated = true

    const annualAmount = depreciableBase * annualRate
    const proRatedAmount = annualAmount * fraction * yearLength
    const rounded = Math.round(proRatedAmount)
    perComponent.push({ name: label, amount: rounded })
    total += rounded
  }

  return {
    amount: total,
    proRated: anyProRated,
    perComponent,
  }
}

interface PriorScheduleRow {
  asset_id: string
  planned_depreciation: number | string
  /** Many-to-one embed: an object, though typed loosely for safety. */
  fiscal_period?:
    | { period_start: string; period_end: string }
    | { period_start: string; period_end: string }[]
    | null
}

/**
 * Each asset's posted history from the prior schedule rows. An asset with a
 * row whose period did not come back falls back to the bare total, which
 * the engine settles as before (cap only).
 */
function priorDepreciationByAsset(rows: readonly PriorScheduleRow[]): Map<string, PriorDepreciation> {
  const history = new Map<string, PostedDepreciationPeriod[]>()
  const totals = new Map<string, number>()
  const incomplete = new Set<string>()
  for (const row of rows) {
    const amount = Number(row.planned_depreciation) || 0
    totals.set(row.asset_id, roundOre((totals.get(row.asset_id) ?? 0) + amount))
    const fiscalPeriod = Array.isArray(row.fiscal_period) ? row.fiscal_period[0] : row.fiscal_period
    if (!fiscalPeriod?.period_start || !fiscalPeriod.period_end) {
      incomplete.add(row.asset_id)
      continue
    }
    const list = history.get(row.asset_id) ?? []
    list.push({ period_start: fiscalPeriod.period_start, period_end: fiscalPeriod.period_end, amount })
    history.set(row.asset_id, list)
  }
  const prior = new Map<string, PriorDepreciation>()
  for (const [assetId, total] of totals) {
    prior.set(assetId, incomplete.has(assetId) ? total : (history.get(assetId) ?? []))
  }
  return prior
}

/**
 * Build a proposal listing planenlig avskrivning för every active asset.
 * Reads existing depreciation_schedules so already-posted entries aren't
 * proposed twice (the unique constraint on (asset_id, fiscal_period_id)
 * would reject duplicates anyway, but the UI wants to display "redan
 * bokförd" rather than fail).
 */
export async function proposeAnnualPostings(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DepreciationProposal> {
  // Loaded here to keep the pure depreciation calculator reusable from the
  // asset disposal service without creating a module initialization cycle.
  const { listAssets } = await import('./asset-service')
  // Both schedule reads are paged on id: one row per asset and year passes
  // 1,000 soon, and the accumulated depreciation then came up short.
  const [periodResult, assets, currentSchedules, priorSchedules] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    listAssets(supabase, companyId),
    // Schedules in the current period (proposal lookup / "already posted" badge)
    fetchAllRows<{ id: string; asset_id: string; journal_entry_id: string | null }>(({ from, to }) =>
      supabase
        .from('depreciation_schedules')
        .select('id, asset_id, journal_entry_id')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    // Posted schedules of the other periods, with each period's dates: the
    // engine needs the posted history to apply a changed useful life or
    // salvage value prospectively and to true up the final period.
    fetchAllRows<PriorScheduleRow>(({ from, to }) =>
      supabase
        .from('depreciation_schedules')
        .select(
          'asset_id, planned_depreciation, journal_entry_id, fiscal_period_id, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_start, period_end)',
        )
        .eq('company_id', companyId)
        .neq('fiscal_period_id', fiscalPeriodId)
        .not('journal_entry_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const existing = new Map<string, { id: string; journal_entry_id: string | null }>(
    currentSchedules.map((r) => [r.asset_id, { id: r.id, journal_entry_id: r.journal_entry_id }]),
  )
  const priorByAsset = priorDepreciationByAsset(priorSchedules)

  const items: AssetDepreciation[] = []
  for (const asset of assets) {
    // Skip assets disposed before period start
    if (asset.disposed_at && asset.disposed_at < period.period_start) continue

    // What Accounted booked before this period: does not count this period's
    // proposal or any unposted current-period draft.
    // Every posted row was read, so an asset without one has an empty history.
    const prior = priorByAsset.get(asset.id) ?? []
    const accumulatedBefore = priorDepreciationTotal(prior, period.period_start)
    const { amount, proRated } = computeAnnualDepreciation(asset, period, prior)
    if (amount <= 0) continue

    const existingSchedule = existing.get(asset.id)
    // Restvärde after this period: cost less the opening accumulated
    // depreciation from a previous system, less what Accounted has booked,
    // less this period's charge.
    const openingAmount = openingDepreciationOf(asset)?.amount ?? 0
    const netBookValueAfter = roundOre(
      Number(asset.acquisition_cost) - openingAmount - accumulatedBefore - amount,
    )

    items.push({
      asset,
      amount,
      netBookValueAfter,
      proRated,
      existingScheduleId: existingSchedule?.id,
      existingJournalEntryId: existingSchedule?.journal_entry_id ?? null,
    })
  }

  return {
    fiscalPeriod: period,
    items,
    totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
  }
}

/**
 * The business event of one planenlig avskrivning (kind asset.depreciated),
 * for the posting port: recorded while POSTING_EVENTS is shadow or strict,
 * never built while it is off. Pure. The asset is the subject, dated the
 * period's end, the amount what the register records. No category: the
 * asset's own accounts carry what it was.
 */
export function assetDepreciationBusinessEvent(args: {
  assetId: string
  amount: number
  periodEnd: string
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'asset.depreciated',
    category: null,
    occurredOn: args.periodEnd,
    subject: { type: 'asset', id: args.assetId },
    // Planenlig avskrivning is in the ledger currency.
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    evidence: { link_basis: args.linkBasis.link_basis, link_evidence: args.linkBasis.link_evidence ?? undefined },
    pendingOperationId: args.linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('assetDepreciation'),
    jurisdiction: 'SE',
  }
}

/**
 * Commit the proposal as journal entries. Creates ONE journal entry per
 * asset (rather than a single batch entry) so each can be reversed
 * independently and so the depreciation_schedules row links one-to-one to
 * its journal entry.
 *
 * Skips assets that already have a posted schedule för this period: the
 * unique constraint would block them, and silently skipping is more useful
 * than throwing. Returns the list of (asset_id, schedule, entry) tuples.
 */
export async function commitAnnualPostings(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options: { assetIds?: string[] } = {},
): Promise<{
  posted: { assetId: string; entry: JournalEntry; scheduleId: string }[]
  skipped: { assetId: string; reason: string }[]
}> {
  const proposal = await proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
  const periodEnd = proposal.fiscalPeriod.period_end
  const periodName = proposal.fiscalPeriod.name

  const allowed = options.assetIds ? new Set(options.assetIds) : null
  const posted: { assetId: string; entry: JournalEntry; scheduleId: string }[] = []
  const skipped: { assetId: string; reason: string }[] = []

  for (const item of proposal.items) {
    if (allowed && !allowed.has(item.asset.id)) continue
    if (item.existingJournalEntryId) {
      skipped.push({ assetId: item.asset.id, reason: 'already_posted' })
      continue
    }

    const lines: CreateJournalEntryLineInput[] = [
      {
        account_number: item.asset.bas_expense_account,
        debit_amount: item.amount,
        credit_amount: 0,
        line_description: `Avskrivning ${item.asset.name}`,
      },
      {
        account_number: item.asset.bas_accumulated_account,
        debit_amount: 0,
        credit_amount: item.amount,
        line_description: `Ack. avskrivning ${item.asset.name}`,
      },
    ]

    // Voucher and register link are ONE database transaction (issue #2779).
    // The old shape committed the voucher and then wrote the schedule row in
    // a second statement, so a failure in between left a posted voucher with
    // no register row. An unposted draft row for (asset, period) is adopted
    // by the RPC; a posted one makes it refuse.
    try {
      // Posting port (step 2): the draft goes through draftJournalEntry, so
      // while POSTING_EVENTS is shadow or strict the asset.depreciated event
      // is recorded first and linked to the draft; commit_asset_depreciation
      // then draws the number and writes the register row as before.
      const draft = await postingPort.draftJournalEntry({
        supabase,
        companyId,
        userId,
        // Built only while the port is on: off, the call is the one it was.
        event: () =>
          assetDepreciationBusinessEvent({
            assetId: item.asset.id,
            amount: item.amount,
            periodEnd,
            linkBasis: linkBasisColumns('user_created'),
          }),
        input: {
          fiscal_period_id: fiscalPeriodId,
          entry_date: periodEnd,
          description: `Planenlig avskrivning ${periodName}: ${item.asset.name}`,
          source_type: 'year_end',
          lines,
        },
      })
      const { entry, scheduleId } = await postingPort.commitSqlPosting({
        supabase,
        companyId,
        userId,
        fn: 'commit_asset_depreciation',
        args: [
          draft,
          {
            asset_id: item.asset.id,
            planned_depreciation: item.amount,
            opening_accumulated_depreciation: Number(item.asset.opening_accumulated_depreciation ?? 0),
            opening_depreciation_date: item.asset.opening_depreciation_date ?? null,
          },
        ],
      })
      posted.push({ assetId: item.asset.id, entry, scheduleId })
    } catch (error) {
      // Posted by someone else first, or the asset was deleted while we
      // waited on its row lock. Nothing was posted for it: skip, carry on.
      if (error instanceof AssetDepreciationRefusedError) {
        skipped.push({ assetId: item.asset.id, reason: error.reason })
        continue
      }
      throw error
    }
  }

  return { posted, skipped }
}

// ============================================================
// Date helpers: keep pure so the unit tests don't need to mock anything.
// ============================================================

function isoToDate(iso: string): Date {
  // Force UTC midnight to avoid local-time DST drift confusing days math.
  return new Date(iso + 'T00:00:00Z')
}

function addMonths(date: Date, months: number): Date {
  // Clamp the day to the last valid day of the target month so end-of-month
  // dates don't overflow forward (Jan 31 + 1 month → Feb 28, not Mar 3).
  const targetMonth = date.getUTCMonth() + months
  const lastDayOfTargetMonth = new Date(
    Date.UTC(date.getUTCFullYear(), targetMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      targetMonth,
      Math.min(date.getUTCDate(), lastDayOfTargetMonth),
    ),
  )
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b
}

function minDate(a: Date, b: Date): Date {
  return a < b ? a : b
}

/**
 * The fiscal year's length in months over 12: exactly 1 for every 12-month
 * year, 1.25 for a förlängt 15-month first year, 0.5 for a förkortat 6-month
 * year. Every path multiplies its 12-month amount by this, after the day
 * share of the year the asset was in use.
 *
 * K2 (BFNAR 2016:10) punkt 10.23, BFN's kommentar: "Omfattar räkenskapsåret
 * annan tid än 12 månader behöver avskrivningen justeras utifrån
 * räkenskapsårets längd." Without it a 15-month year never carried more
 * than 12 months of depreciation and a 6-month year carried a full 12.
 */
function fiscalYearLengthFactor(periodStart: Date, periodEndInclusive: Date): number {
  return fractionalMonthsBetween(periodStart, addDays(periodEndInclusive, 1)) / 12
}

/**
 * Months from `start` (inclusive) to `endExclusive`, fractional: whole
 * calendar months stepped with the same end-of-month clamping as addMonths,
 * plus the leftover days as a share of the next month's length.
 */
function fractionalMonthsBetween(start: Date, endExclusive: Date): number {
  if (endExclusive <= start) return 0
  let whole = 0
  while (addMonths(start, whole + 1) <= endExclusive) whole += 1
  const stepStart = addMonths(start, whole)
  const stepEnd = addMonths(start, whole + 1)
  const leftover = daysBetween(stepStart, endExclusive)
  const stepDays = daysBetween(stepStart, stepEnd)
  return whole + (stepDays > 0 ? leftover / stepDays : 0)
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}
