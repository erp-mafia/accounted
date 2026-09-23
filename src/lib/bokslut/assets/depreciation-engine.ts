import type { SupabaseClient } from '@supabase/supabase-js'
import { createAssetDepreciationEntry } from '@/lib/bookkeeping/engine'
import { AssetDepreciationRefusedError } from '@/lib/bookkeeping/errors'
import { roundOre } from '@/lib/money'
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
 * Compute avskrivning för en enskild tillgång under en given fiscal period.
 *
 * Ordinary depreciation is always linear at asset level and pro-rates by the
 * active-life overlap. The pooled 30, 20 and 25 percent tax rules live in
 * tax-depreciation.ts and never create ordinary per-asset postings.
 */
export function computeAnnualDepreciation(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  /** Depreciation booked IN ACCOUNTED for this asset before this period
   *  (posted schedules). Excludes the opening balance: that is read from the
   *  asset itself. Only the opening-balance path uses it, to cap the charge
   *  at the remaining value. */
  priorAccumulated: number = 0,
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
  if (opening) {
    return computeLinearFromOpening(asset, fiscalPeriod, opening, priorAccumulated)
  }

  return computeLinearAnnual(asset, fiscalPeriod)
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

/**
 * Opening accumulated depreciation that is already on the books at the START
 * of a period beginning `periodStart`: the whole opening amount when it is
 * stated per a date before that, else 0.
 */
export function openingAccumulatedBefore(asset: Asset, periodStart: string): number {
  const opening = openingDepreciationOf(asset)
  return opening && opening.date < periodStart ? opening.amount : 0
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
 *
 * The charge is capped at what is left after the opening amount and the
 * depreciation already booked in Accounted, so the final period absorbs the
 * whole-krona rounding and the total lands öre-exactly on the remaining
 * value.
 */
function computeLinearFromOpening(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
  opening: OpeningDepreciation,
  priorAccumulated: number,
): { amount: number; proRated: boolean } {
  const acquisitionCost = Number(asset.acquisition_cost)
  const salvageValue = Number(asset.salvage_value)
  const remainingBase = roundOre(acquisitionCost - salvageValue - opening.amount)
  if (remainingBase <= 0) return { amount: 0, proRated: false }

  const acquisition = isoToDate(asset.acquisition_date)
  const lifeEndExclusive = addMonths(acquisition, asset.useful_life_months)
  const remainingStart = maxDate(addDays(isoToDate(opening.date), 1), acquisition)
  if (remainingStart >= lifeEndExclusive) return { amount: 0, proRated: false }

  const remainingMonths = fractionalMonthsBetween(remainingStart, lifeEndExclusive)
  if (remainingMonths <= 0) return { amount: 0, proRated: false }

  const periodStart = isoToDate(fiscalPeriod.period_start)
  const periodEndInclusive = isoToDate(fiscalPeriod.period_end)
  const disposalEnd = asset.disposed_at ? isoToDate(asset.disposed_at) : null

  const windowStart = maxDate(remainingStart, periodStart)
  let windowEnd = minDate(periodEndInclusive, addDays(lifeEndExclusive, -1))
  if (disposalEnd) windowEnd = minDate(windowEnd, disposalEnd)
  if (windowEnd < windowStart) return { amount: 0, proRated: false }

  const fullPeriodDays = daysBetween(periodStart, periodEndInclusive) + 1
  const windowDays = daysBetween(windowStart, windowEnd) + 1
  const fraction = windowDays / fullPeriodDays
  const proRated = fraction < 0.999

  const annualAmount = (remainingBase * 12) / remainingMonths
  const planned = Math.round(annualAmount * fraction)
  const left = roundOre(remainingBase - (Number(priorAccumulated) || 0))
  if (left <= 0) return { amount: 0, proRated }

  // The period that reaches the end of the life takes exactly what is left,
  // so whole-krona rounding never strands öre on the asset.
  const reachesLifeEnd = windowEnd >= addDays(lifeEndExclusive, -1)
  const amount = reachesLifeEnd ? left : Math.min(planned, left)
  return { amount: roundOre(amount), proRated }
}

function computeLinearAnnual(
  asset: Asset,
  fiscalPeriod: Pick<FiscalPeriod, 'period_start' | 'period_end'>,
): { amount: number; proRated: boolean } {
  const acquisitionCost = Number(asset.acquisition_cost)
  const salvageValue = Number(asset.salvage_value)
  const depreciableBase = acquisitionCost - salvageValue
  if (depreciableBase <= 0) return { amount: 0, proRated: false }

  const usefulLifeMonths = asset.useful_life_months
  const annualRate = 12 / usefulLifeMonths

  // Determine the depreciation window for this period: the overlap between
  // the asset's active life and the fiscal period.
  const acquisition = isoToDate(asset.acquisition_date)
  const lifeEndExclusive = addMonths(acquisition, usefulLifeMonths)
  const periodStart = isoToDate(fiscalPeriod.period_start)
  const periodEndInclusive = isoToDate(fiscalPeriod.period_end)
  const disposalEnd = asset.disposed_at ? isoToDate(asset.disposed_at) : null

  const windowStart = maxDate(acquisition, periodStart)
  let windowEnd = minDate(periodEndInclusive, addDays(lifeEndExclusive, -1))
  if (disposalEnd) windowEnd = minDate(windowEnd, disposalEnd)

  if (windowEnd < windowStart) return { amount: 0, proRated: false }

  const fullPeriodDays = daysBetween(periodStart, periodEndInclusive) + 1
  const windowDays = daysBetween(windowStart, windowEnd) + 1
  const fraction = windowDays / fullPeriodDays
  const proRated = fraction < 0.999

  // Full-year amount = annualRate × depreciableBase (linear).
  const annualAmount = depreciableBase * annualRate
  const proRatedAmount = annualAmount * fraction

  return {
    amount: Math.round(proRatedAmount),
    proRated,
  }
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
 * annual amount is `depreciableBase × 12 / useful_life_months`. The
 * pro-ration window is the overlap between the period and the asset's
 * active life: components share the same acquisition_date and disposal
 * date as the parent asset, because BFNAR 2012:1 treats them as a single
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
    const proRatedAmount = annualAmount * fraction
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
  const [periodResult, assets, currentSchedulesResult, priorSchedulesResult] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    listAssets(supabase, companyId),
    // Schedules in the current period (proposal lookup / "already posted" badge)
    supabase
      .from('depreciation_schedules')
      .select('id, asset_id, journal_entry_id')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId),
    // Prior posted schedules (excluding the current period) so we can compute
    // the true accumulated depreciation per asset for net book value.
    supabase
      .from('depreciation_schedules')
      .select('asset_id, planned_depreciation, journal_entry_id, fiscal_period_id')
      .eq('company_id', companyId)
      .neq('fiscal_period_id', fiscalPeriodId)
      .not('journal_entry_id', 'is', null),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const existing = new Map<string, { id: string; journal_entry_id: string | null }>(
    (currentSchedulesResult.data ?? []).map(
      (r: { id: string; asset_id: string; journal_entry_id: string | null }) => [
        r.asset_id,
        { id: r.id, journal_entry_id: r.journal_entry_id },
      ],
    ),
  )

  // Sum of all prior posted depreciation per asset. This is the accumulated
  // depreciation on the books before this period: does not yet count this
  // period's proposal or any unposted current-period draft.
  const priorAccumulated = new Map<string, number>()
  for (const row of (priorSchedulesResult.data ?? []) as Array<{
    asset_id: string
    planned_depreciation: number | string
  }>) {
    const v = Number(row.planned_depreciation) || 0
    priorAccumulated.set(row.asset_id, (priorAccumulated.get(row.asset_id) ?? 0) + v)
  }

  const items: AssetDepreciation[] = []
  for (const asset of assets) {
    // Skip assets disposed before period start
    if (asset.disposed_at && asset.disposed_at < period.period_start) continue

    const accumulatedBefore = priorAccumulated.get(asset.id) ?? 0
    const { amount, proRated } = computeAnnualDepreciation(
      asset,
      period,
      accumulatedBefore,
    )
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
      const { entry, scheduleId } = await createAssetDepreciationEntry(
        supabase,
        companyId,
        userId,
        {
          fiscal_period_id: fiscalPeriodId,
          entry_date: periodEnd,
          description: `Planenlig avskrivning ${periodName}: ${item.asset.name}`,
          source_type: 'year_end',
          lines,
        },
        {
          asset_id: item.asset.id,
          planned_depreciation: item.amount,
          opening_accumulated_depreciation: Number(item.asset.opening_accumulated_depreciation ?? 0),
          opening_depreciation_date: item.asset.opening_depreciation_date ?? null,
        },
      )
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
