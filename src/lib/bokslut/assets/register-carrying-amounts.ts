/**
 * The register's carrying amount of each asset at the end of a day
 * (carryingAmountAt): cost less the opening, the planenlig avskrivning
 * posted for years ending on or before the day (per component for a
 * component asset) and the net write-down. One read of the posted history
 * for the assets given, none when there are none.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { chunk } from '@/lib/utils'
import { carryingAmountAt } from './carrying-amount'
import { hasComponents } from './component-depreciation'
import { loadComponentSplits, postedByComponent } from './component-history'
import type { Asset } from '@/types'

export async function loadCarryingAmountsAt(
  supabase: SupabaseClient,
  companyId: string,
  assets: readonly Asset[],
  day: string,
): Promise<Map<string, number>> {
  const amounts = new Map<string, number>()
  if (assets.length === 0) return amounts
  type Row = {
    id: string
    asset_id: string
    planned_depreciation: number | string
    fiscal_period: { period_end: string } | { period_end: string }[] | null
  }
  const rows = (
    await Promise.all(
      chunk(assets.map((asset) => asset.id), 200).map((ids) =>
        fetchAllRows<Row>(({ from, to }) =>
          supabase
            .from('depreciation_schedules')
            .select('id, asset_id, planned_depreciation, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_end)')
            .eq('company_id', companyId)
            .in('asset_id', ids)
            .not('journal_entry_id', 'is', null)
            .order('id', { ascending: true })
            .range(from, to),
        ),
      ),
    )
  ).flat()
  const posted = new Map<string, number>()
  const throughIds = new Set<string>()
  const componentAssetIds = new Set(assets.filter((asset) => hasComponents(asset)).map((asset) => asset.id))
  const componentScheduleIds: string[] = []
  for (const row of rows) {
    const fiscalPeriod = Array.isArray(row.fiscal_period) ? row.fiscal_period[0] : row.fiscal_period
    if (!fiscalPeriod || fiscalPeriod.period_end > day) continue
    throughIds.add(row.id)
    if (componentAssetIds.has(row.asset_id)) componentScheduleIds.push(row.id)
    posted.set(row.asset_id, roundOre((posted.get(row.asset_id) ?? 0) + (Number(row.planned_depreciation) || 0)))
  }
  const byComponent = componentScheduleIds.length === 0
    ? new Map<string, number>()
    : postedByComponent(await loadComponentSplits(supabase, companyId, componentScheduleIds), throughIds)
  for (const asset of assets) {
    amounts.set(asset.id, carryingAmountAt(asset, day, { total: posted.get(asset.id) ?? 0, byComponent }))
  }
  return amounts
}
