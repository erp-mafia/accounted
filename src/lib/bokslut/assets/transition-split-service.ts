/**
 * Splitting the register's plain assets on components at the transition to
 * K3 (BFNAR 2012:1 35.18), through split_asset_at_k3_transition. The split
 * books nothing: the asset's cost and accumulated depreciation are only
 * divided (transition-split.ts). It is undone, or made again, while nothing
 * has been posted per component.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { K3TransitionBlockedError, k3TransitionBlockFromRpc } from '@/lib/bookkeeping/errors'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { AssetComponentsInvalidError, AssetNotFoundError, getAsset, listAssets } from './asset-service'
import { depreciationStartOf } from './asset-units'
import { hasComponents } from './component-depreciation'
import { monthsUsedBefore, transitionSplitRows, type TransitionSplitRow } from './transition-split'
import type { Asset } from '@/types'

export const TransitionSplitSchema = z
  .object({
    components: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            carrying_amount: z.number().min(0).max(1_000_000_000_000),
            useful_life_months: z.number().int().positive().max(1200).nullable(),
            salvage_value: z.number().min(0).max(1_000_000_000_000).default(0),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()

export type TransitionSplitRequest = z.infer<typeof TransitionSplitSchema>

/** Where an asset stands for the 35.18 split. */
export type TransitionSplitStatus =
  /** Split at the transition; can still be changed or undone. */
  | 'split'
  /** Already on components (registered as a K3 asset); nothing to do. */
  | 'components'
  /** One plan as under K2: can be split. */
  | 'plain'
  /** Depreciation posted from the transition on: storno it before splitting. */
  | 'later_depreciation_posted'

export interface TransitionSplitCandidate {
  asset_id: string
  name: string
  category: Asset['category']
  acquisition_date: string
  status: TransitionSplitStatus
  cost: number
  /** Accumulated depreciation at the transition. */
  accumulated: number
  carrying_amount: number
  /** Months of use before the transition (the useful lives must exceed it). */
  months_used: number
  /** The split as made, for a split asset. */
  components: Array<{ name: string; carrying_amount: number; useful_life_months: number | null; salvage_value: number }>
}

interface SplitRow {
  asset_id: string
  carried_accumulated: number | string
  original_cost: number | string
}

interface TransitionRef {
  transitionDate: string
}

async function loadTransitionRef(supabase: SupabaseClient, companyId: string): Promise<TransitionRef> {
  const { data, error } = await supabase
    .from('k3_transitions')
    .select('id, fiscal_period:fiscal_periods!k3_transitions_fiscal_period_id_fkey(period_start)')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa övergången till K3: ${error.message}`)
  const period = (data as { fiscal_period?: { period_start: string } | { period_start: string }[] | null } | null)
    ?.fiscal_period
  const start = Array.isArray(period) ? period[0]?.period_start : period?.period_start
  if (!data || !start) throw new K3TransitionBlockedError('not_started')
  return { transitionDate: start }
}

/** Posted planenlig avskrivning per asset, and whether any is from the transition on. */
async function postedPlainHistory(
  supabase: SupabaseClient,
  companyId: string,
  assetIds: readonly string[],
  transitionDate: string,
): Promise<{ total: Map<string, number>; later: Set<string> }> {
  const total = new Map<string, number>()
  const later = new Set<string>()
  type Row = {
    id: string
    asset_id: string
    planned_depreciation: number | string
    fiscal_period: { period_end: string } | { period_end: string }[] | null
  }
  for (const ids of chunk([...assetIds], 200)) {
    const rows = await fetchAllRows<Row>(({ from, to }) =>
      supabase
        .from('depreciation_schedules')
        .select('id, asset_id, planned_depreciation, fiscal_period:fiscal_periods!depreciation_schedules_fiscal_period_id_fkey(period_end)')
        .eq('company_id', companyId)
        .in('asset_id', ids)
        .not('journal_entry_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const row of rows) {
      const period = Array.isArray(row.fiscal_period) ? row.fiscal_period[0] : row.fiscal_period
      if (period && period.period_end >= transitionDate) later.add(row.asset_id)
      total.set(row.asset_id, roundOre((total.get(row.asset_id) ?? 0) + (Number(row.planned_depreciation) || 0)))
    }
  }
  return { total, later }
}

async function loadSplits(supabase: SupabaseClient, companyId: string): Promise<Map<string, SplitRow>> {
  const rows = await fetchAllRows<SplitRow>(({ from, to }) =>
    supabase
      .from('asset_transition_splits')
      .select('asset_id, carried_accumulated, original_cost')
      .eq('company_id', companyId)
      .order('asset_id', { ascending: true })
      .range(from, to),
  )
  return new Map(rows.map((row) => [row.asset_id, row]))
}

function splittable(asset: Asset, transitionDate: string): boolean {
  return (
    !asset.disposed_at &&
    asset.category !== 'immaterial' &&
    asset.category !== 'land' &&
    asset.acquisition_date < transitionDate
  )
}

/** The register's tangible assets from before the transition, as the 35.18 split sees them. */
export async function listTransitionSplitCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transitionDate: string,
): Promise<TransitionSplitCandidate[]> {
  const assets = (await listAssets(supabase, companyId)).filter((asset) => splittable(asset, transitionDate))
  if (assets.length === 0) return []
  const [history, splits] = await Promise.all([
    postedPlainHistory(supabase, companyId, assets.map((asset) => asset.id), transitionDate),
    loadSplits(supabase, companyId),
  ])
  return assets.map((asset) => {
    const split = splits.get(asset.id)
    const months = monthsUsedBefore({ depreciationStart: depreciationStartOf(asset), transitionDate })
    const status: TransitionSplitStatus = split
      ? 'split'
      : hasComponents(asset)
        ? 'components'
        : history.later.has(asset.id)
          ? 'later_depreciation_posted'
          : 'plain'
    const cost = split ? roundOre(Number(split.original_cost)) : roundOre(Number(asset.acquisition_cost))
    const accumulated = split
      ? roundOre(Number(split.carried_accumulated))
      : roundOre((Number(asset.opening_accumulated_depreciation ?? 0) || 0) + (history.total.get(asset.id) ?? 0))
    return {
      asset_id: asset.id,
      name: asset.name,
      category: asset.category,
      acquisition_date: asset.acquisition_date,
      status,
      cost,
      accumulated: status === 'components' ? 0 : accumulated,
      carrying_amount: roundOre(cost - (status === 'components' ? 0 : accumulated)),
      months_used: months,
      components:
        status === 'split'
          ? (asset.components ?? [])
              .filter((component) => component.derecognised_at === null)
              .map((component) => ({
                name: component.name,
                carrying_amount: roundOre(Number(component.cost) - Number(component.opening_accumulated_depreciation ?? 0)),
                useful_life_months: component.useful_life_months,
                salvage_value: roundOre(Number(component.salvage_value ?? 0)),
              }))
          : [],
    }
  })
}

function refusal(error: { code?: string; message: string }): never {
  if (error.code === 'PT409') {
    const reason = k3TransitionBlockFromRpc(error.message)
    if (reason) throw new K3TransitionBlockedError(reason)
  }
  if (error.code === 'P0002') throw new AssetNotFoundError()
  if (error.code === '23514' && /locked|closed/i.test(error.message)) throw new K3TransitionBlockedError('period_locked')
  throw new Error(`Kunde inte dela upp tillgången vid övergången till K3: ${error.message}`)
}

/** The split as split_asset_at_k3_transition takes it, for a dry run. */
export interface TransitionSplitPlan {
  asset_id: string
  transition_date: string
  /** Empty: the split is undone. */
  components: TransitionSplitRow[]
}

/**
 * Split an asset on components at the transition (35.18), make the split
 * again, or undo it (no components). Returns the asset as it now stands;
 * a dry run answers the components as they would be written instead.
 */
export async function splitAssetAtTransition(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  request: TransitionSplitRequest,
  options: { dryRun: true },
): Promise<TransitionSplitPlan>
export async function splitAssetAtTransition(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  request: TransitionSplitRequest,
  options?: { dryRun?: false },
): Promise<Asset>
export async function splitAssetAtTransition(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  request: TransitionSplitRequest,
  options: { dryRun?: boolean } = {},
): Promise<Asset | TransitionSplitPlan> {
  const { transitionDate } = await loadTransitionRef(supabase, companyId)
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()

  let rows: TransitionSplitRow[] = []
  if (request.components.length > 0) {
    const candidate = (await listTransitionSplitCandidates(supabase, companyId, transitionDate)).find(
      (row) => row.asset_id === assetId,
    )
    if (!candidate) {
      throw new K3TransitionBlockedError(
        asset.disposed_at
          ? 'asset_disposed'
          : asset.acquisition_date >= transitionDate
            ? 'asset_acquired_under_k3'
            : 'asset_not_splittable',
      )
    }
    if (candidate.status === 'components') throw new K3TransitionBlockedError('asset_has_components')
    if (candidate.status === 'later_depreciation_posted') throw new K3TransitionBlockedError('later_depreciation_posted')
    const split = transitionSplitRows(
      {
        cost: candidate.cost,
        carried: candidate.accumulated,
        depreciationStart: depreciationStartOf(asset),
        transitionDate,
      },
      request.components,
    )
    if (split.errors.length > 0) throw new AssetComponentsInvalidError(split.errors)
    rows = split.rows
  }
  if (options.dryRun) return { asset_id: assetId, transition_date: transitionDate, components: rows }

  const { error } = await supabase.rpc('split_asset_at_k3_transition', {
    p_company_id: companyId,
    p_asset_id: assetId,
    p_components: rows,
  })
  if (error) refusal(error)
  return (await getAsset(supabase, companyId, assetId)) ?? asset
}
