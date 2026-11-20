/**
 * The posted per-component history of the asset register: what each
 * component was charged in each posted planenlig avskrivning
 * (depreciation_schedule_components, written by commit_asset_depreciation and
 * commit_asset_disposal in the voucher transaction).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'

export interface ComponentSplitRow {
  schedule_id: string
  component_id: string
  amount: number
}

/**
 * The split rows of the given (posted) schedules. Paged and in id slices, so
 * a register with many years stays inside one request URL and past
 * PostgREST's 1,000-row cap.
 */
export async function loadComponentSplits(
  supabase: SupabaseClient,
  companyId: string,
  scheduleIds: readonly string[],
): Promise<ComponentSplitRow[]> {
  const rows: ComponentSplitRow[] = []
  for (const ids of chunk([...new Set(scheduleIds)], 200)) {
    try {
      const page = await fetchAllRows<{ schedule_id: string; component_id: string; amount: number | string }>(
        ({ from, to }) =>
          supabase
            .from('depreciation_schedule_components')
            .select('schedule_id, component_id, amount')
            .eq('company_id', companyId)
            .in('schedule_id', ids)
            .order('schedule_id', { ascending: true })
            .order('component_id', { ascending: true })
            .range(from, to),
      )
      for (const row of page) {
        rows.push({ schedule_id: row.schedule_id, component_id: row.component_id, amount: Number(row.amount) || 0 })
      }
    } catch (error) {
      throw new Error(
        `Failed to load the component split: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return rows
}

/** Sum per component of the split rows of the given schedules. */
export function postedByComponent(
  splits: readonly ComponentSplitRow[],
  scheduleIds: ReadonlySet<string>,
): Map<string, number> {
  const sums = new Map<string, number>()
  for (const row of splits) {
    if (!scheduleIds.has(row.schedule_id)) continue
    sums.set(row.component_id, roundOre((sums.get(row.component_id) ?? 0) + row.amount))
  }
  return sums
}
