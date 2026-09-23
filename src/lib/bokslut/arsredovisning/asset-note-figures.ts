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
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeAnnualDepreciation } from '@/lib/bokslut/assets/depreciation-engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Asset } from '@/types'

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

const round2 = (n: number) => Math.round(n * 100) / 100

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
    accumulated = round2(accumulated + amount)
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
}): Map<string, AssetDepreciationFigures> {
  const { assets, postedSchedules, fiscalPeriods, currentPeriodId } = params
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

  const figures = new Map<string, AssetDepreciationFigures>()
  for (const asset of assets) {
    if (asset.disposed_at && asset.disposed_at < currentPeriod.period_start) continue

    const rows = byAsset.get(asset.id) ?? []
    const currentPosted = rows.find((r) => r.fiscal_period_id === currentPeriodId)
    const priorPosted = rows.filter((r) => {
      const start = periodStartById.get(r.fiscal_period_id)
      return start != null && start < currentPeriod.period_start
    })

    let ibAck: number
    if (priorPosted.length > 0) {
      ibAck = round2(
        priorPosted.reduce((sum, r) => sum + (Number(r.planned_depreciation) || 0), 0),
      )
    } else if (asset.acquisition_date >= currentPeriod.period_start) {
      ibAck = 0
    } else {
      ibAck = fallbackAccumulatedBefore(asset, currentPeriod.period_start, fiscalPeriods)
    }

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
        avgaendeAck = round2(
          rows.reduce((sum, r) => sum + (Number(r.planned_depreciation) || 0), 0),
        )
      } else {
        // Nothing ever posted: preview what the engine would have booked so
        // the disposed asset still nets out of the roll-forward.
        aretsAvskrivning = computeAnnualDepreciation(asset, currentPeriod, ibAck).amount
        avgaendeAck = round2(ibAck + aretsAvskrivning)
      }
    } else if (currentPosted) {
      aretsAvskrivning = Number(currentPosted.planned_depreciation) || 0
    } else {
      aretsAvskrivning = computeAnnualDepreciation(asset, currentPeriod, ibAck).amount
    }

    figures.set(asset.id, {
      ibAck,
      aretsAvskrivning: round2(aretsAvskrivning),
      avgaendeAck,
    })
  }
  return figures
}
