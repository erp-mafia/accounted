/**
 * Per-asset depreciation figures for the anläggningstillgångar roll-forward
 * note (ÅRL 5:8 §), anchored to what was actually BOOKED.
 *
 * The note must reconcile with the balansräkning, which is ledger-driven.
 * Posted `depreciation_schedules` rows are the source of truth: they carry
 * the exact amounts the engine committed to the journal, and they are also
 * exactly what `disposeAsset()` reverses via `sumPostedDepreciation()`.
 *
 * Fallbacks (only when nothing is posted for the relevant span) reuse the
 * booking engine's `computeAnnualDepreciation` so the note previews the
 * same amount that WOULD be booked: never a parallel formula. For years
 * before the company's fiscal periods exist in the DB (pre-onboarding
 * assets), synthetic 12-month windows are stepped back from the earliest
 * known period start; irregular pre-onboarding years are approximated,
 * which the balansräkning tie-out warning in build-data surfaces.
 *
 * An asset split on components at the transition to K3 (K3 35.18,
 * split_asset_at_k3_transition) carries everything depreciated before the
 * transition in its components' openings: the asset's own opening plus every
 * schedule posted on it as a whole. Its posted K2 rows stay on the register,
 * so from the transition on they are already in the opening and are not
 * counted again; a year before the transition sees the plain asset as it was
 * before the split (the split row keeps that opening for an exact undo).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeAnnualDepreciation,
  openingDepreciationOf,
} from '@/lib/bokslut/assets/depreciation-engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Asset } from '@/types'
import { roundOre } from '@/lib/money'

export interface AssetDepreciationFigures {
  /** Accumulated depreciation on the books at period start. */
  ibAck: number
  /** Depreciation charged during the period (posted schedule, else engine). */
  aretsAvskrivning: number
  /** Accumulated depreciation reversed on in-period disposal. */
  avgaendeAck: number
}

export interface PostedScheduleRow {
  asset_id: string
  fiscal_period_id: string
  /** NUMERIC arrives as string from PostgREST. */
  planned_depreciation: number | string
  journal_entry_id: string | null
}

export interface PeriodLike {
  id: string
  period_start: string
  period_end: string
}

/** An asset split on components at the transition to K3 (asset_transition_splits). */
export interface TransitionSplitOpening {
  asset_id: string
  /** The transition date: the first day of the first K3 year. */
  split_date: string
  /** The plain asset before the split. NUMERIC arrives as string. */
  original_cost: number | string
  original_opening: number | string
  original_opening_date: string | null
  original_salvage: number | string
}

/** The company's K3 transition splits, paginated. */
export async function loadTransitionSplitOpenings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<TransitionSplitOpening[]> {
  return fetchAllRows<TransitionSplitOpening>(({ from, to }) =>
    supabase
      .from('asset_transition_splits')
      .select('asset_id, split_date, original_cost, original_opening, original_opening_date, original_salvage')
      .eq('company_id', companyId)
      .order('asset_id')
      .range(from, to),
  )
}

/** Whether the register holds component rows for the asset: only such an asset can have been split. */
export function hasComponentRows(asset: Pick<Asset, 'components' | 'k3_components'>): boolean {
  return (Array.isArray(asset.components) && asset.components.length > 0)
    || (Array.isArray(asset.k3_components) && asset.k3_components.length > 0)
}

/**
 * The asset as the note reads it for a period starting `periodStart`: before
 * the transition, the plain asset as it was before the split (cost, salvage
 * and opening from the split row, no components); from the transition, the
 * split asset as registered.
 */
export function noteAsset(asset: Asset, split: TransitionSplitOpening | undefined, periodStart: string): Asset {
  if (!split || periodStart >= split.split_date) return asset
  const opening = roundOre(Number(split.original_opening) || 0)
  return {
    ...asset,
    k3_components: null,
    components: [],
    acquisition_cost: roundOre(Number(split.original_cost) || 0),
    salvage_value: roundOre(Number(split.original_salvage) || 0),
    opening_accumulated_depreciation: opening,
    opening_depreciation_date: opening > 0 ? split.original_opening_date : null,
  }
}

/**
 * Whether a posted schedule of a period starting `start` is counted on top
 * of the asset's opening. From the transition a split asset's opening already
 * holds every row posted before the transition date, so only rows of periods
 * from that date count; a row whose period is unknown cannot be placed and is
 * not counted for a split asset. Otherwise every row counts.
 */
function countsOnTopOfOpening(
  split: TransitionSplitOpening | undefined,
  periodStart: string,
  rowPeriodStart: string | undefined,
): boolean {
  if (!split || periodStart < split.split_date) return true
  return rowPeriodStart !== undefined && rowPeriodStart >= split.split_date
}

/** Posted (journal-linked) schedule rows for the whole company, paginated. */
export async function loadPostedSchedules(
  supabase: SupabaseClient,
  companyId: string,
): Promise<PostedScheduleRow[]> {
  return fetchAllRows<PostedScheduleRow>(({ from, to }) =>
    supabase
      .from('depreciation_schedules')
      .select('asset_id, fiscal_period_id, planned_depreciation, journal_entry_id')
      .eq('company_id', companyId)
      .not('journal_entry_id', 'is', null)
      .order('id')
      .range(from, to),
  )
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Shift an ISO date by whole years, clamping Feb 29 to Feb 28. */
function isoShiftYears(iso: string, deltaYears: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const year = d.getUTCFullYear() + deltaYears
  const month = d.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay)))
    .toISOString()
    .slice(0, 10)
}

/**
 * Accumulated depreciation at period start for an asset with NO posted
 * prior schedules. Iterates prior years chronologically through the
 * engine (declining methods compound, so order matters): real DB fiscal
 * periods where they exist, synthetic 12-month windows stepped back from
 * the earliest known period start for the pre-onboarding years before.
 */
function fallbackAccumulatedBefore(
  asset: Asset,
  currentPeriodStart: string,
  fiscalPeriods: PeriodLike[],
): number {
  const priorPeriods = fiscalPeriods
    .filter((p) => p.period_start < currentPeriodStart)
    .sort((a, b) => a.period_start.localeCompare(b.period_start))

  const anchorStart =
    priorPeriods.length > 0 ? priorPeriods[0].period_start : currentPeriodStart
  const synthetic: { period_start: string; period_end: string }[] = []
  let windowEnd = isoAddDays(anchorStart, -1)
  let windowStart = isoShiftYears(anchorStart, -1)
  while (windowEnd >= asset.acquisition_date) {
    synthetic.unshift({ period_start: windowStart, period_end: windowEnd })
    windowEnd = isoAddDays(windowStart, -1)
    windowStart = isoShiftYears(windowStart, -1)
  }

  let accumulated = 0
  for (const window of [...synthetic, ...priorPeriods]) {
    if (window.period_end < asset.acquisition_date) continue
    const { amount } = computeAnnualDepreciation(asset, window, accumulated)
    accumulated = roundOre(accumulated + amount)
  }
  return accumulated
}

/**
 * Resolve booked-anchored figures for every asset alive in the period.
 * Assets disposed before the period are omitted (the note skips them).
 */
export function computeAssetNoteFigures(params: {
  assets: Asset[]
  postedSchedules: PostedScheduleRow[]
  fiscalPeriods: PeriodLike[]
  currentPeriodId: string
  /** Assets split on components at the transition to K3. */
  transitionSplits?: readonly TransitionSplitOpening[]
}): Map<string, AssetDepreciationFigures> {
  const { postedSchedules, fiscalPeriods, currentPeriodId } = params
  const currentPeriod = fiscalPeriods.find((p) => p.id === currentPeriodId)
  if (!currentPeriod) {
    throw new Error('Current fiscal period not found in fiscal period list')
  }

  const periodStartById = new Map(fiscalPeriods.map((p) => [p.id, p.period_start]))
  const byAsset = new Map<string, PostedScheduleRow[]>()
  for (const row of postedSchedules) {
    if (row.journal_entry_id == null) continue
    const list = byAsset.get(row.asset_id)
    if (list) list.push(row)
    else byAsset.set(row.asset_id, [row])
  }

  const splitByAsset = new Map((params.transitionSplits ?? []).map((split) => [split.asset_id, split]))

  const figures = new Map<string, AssetDepreciationFigures>()
  for (const registered of params.assets) {
    if (registered.disposed_at && registered.disposed_at < currentPeriod.period_start) continue

    const split = splitByAsset.get(registered.id)
    const asset = noteAsset(registered, split, currentPeriod.period_start)
    // Rows already in the opening (posted before a K3 transition split) are
    // not counted again.
    const rows = (byAsset.get(asset.id) ?? []).filter((r) =>
      countsOnTopOfOpening(split, currentPeriod.period_start, periodStartById.get(r.fiscal_period_id)),
    )
    const currentPosted = rows.find((r) => r.fiscal_period_id === currentPeriodId)
    const priorPosted = rows.filter((r) => {
      const start = periodStartById.get(r.fiscal_period_id)
      return start != null && start < currentPeriod.period_start
    })

    // Depreciation booked in a previous system before the asset entered
    // Accounted. It is on the ledger's 12x9 balance but on no schedule row,
    // so it is added to the booked figures here. An opening amount dated
    // inside the current period is treated as on the books at its start (the
    // usual case is a fiscal-year-end date, which lands before the period).
    const opening = openingDepreciationOf(asset)
    const openingAck =
      opening && opening.date <= currentPeriod.period_end ? opening.amount : 0

    // Depreciation booked or planned in Accounted before the period. The
    // engine is fed this alone (its opening-balance path reads the opening
    // amount from the asset itself).
    let accountedAck: number
    if (priorPosted.length > 0) {
      accountedAck = roundOre(
        priorPosted.reduce((sum, r) => sum + (Number(r.planned_depreciation) || 0), 0),
      )
    } else if (asset.acquisition_date >= currentPeriod.period_start) {
      accountedAck = 0
    } else {
      accountedAck = fallbackAccumulatedBefore(asset, currentPeriod.period_start, fiscalPeriods)
    }
    const ibAck = roundOre(openingAck + accountedAck)

    const disposedDuringPeriod =
      asset.disposed_at != null &&
      asset.disposed_at >= currentPeriod.period_start &&
      asset.disposed_at <= currentPeriod.period_end

    let aretsAvskrivning: number
    let avgaendeAck = 0
    if (disposedDuringPeriod) {
      const hasAnyPosted = rows.length > 0
      if (hasAnyPosted) {
        // Mirror sumPostedDepreciation()/disposeAsset(): the ledger reversed
        // exactly the sum of all posted rows, and the current year's charge
        // is whatever was posted for this period (often nothing).
        aretsAvskrivning = currentPosted
          ? Number(currentPosted.planned_depreciation) || 0
          : 0
        avgaendeAck = roundOre(
          openingAck +
            rows.reduce((sum, r) => sum + (Number(r.planned_depreciation) || 0), 0),
        )
      } else {
        // Nothing ever posted: preview what the engine would have booked so
        // the disposed asset still nets out of the roll-forward.
        aretsAvskrivning = computeAnnualDepreciation(asset, currentPeriod, accountedAck).amount
        avgaendeAck = roundOre(ibAck + aretsAvskrivning)
      }
    } else if (currentPosted) {
      aretsAvskrivning = Number(currentPosted.planned_depreciation) || 0
    } else {
      aretsAvskrivning = computeAnnualDepreciation(asset, currentPeriod, accountedAck).amount
    }

    figures.set(asset.id, {
      ibAck,
      aretsAvskrivning: roundOre(aretsAvskrivning),
      avgaendeAck,
    })
  }
  return figures
}
