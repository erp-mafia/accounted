import type { SupabaseClient } from '@supabase/supabase-js'
import type { Asset, AssetCategory } from '@/types'
import { roundOre } from '@/lib/money'
import { listAssets } from './asset-service'
import {
  TAX_DEPRECIATION_CATEGORIES,
  computeTaxDepreciation,
  fiscalPeriodMonths,
  type TaxDepreciationCohort,
  type TaxDepreciationMethod,
  type TaxDepreciationResult,
  type TaxDepreciationRule,
} from './tax-depreciation'

export interface TaxPeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
  previous_period_id: string | null
  is_closed: boolean
  locked_at: string | null
  closing_entry_id: string | null
  tax_depreciation_method: TaxDepreciationMethod | null
  tax_depreciation_rule: TaxDepreciationRule | null
  tax_depreciation_opening_value: number | string | null
  tax_depreciation_base: number | string | null
  tax_depreciation_deduction: number | string | null
  tax_depreciation_closing_value: number | string | null
  tax_depreciation_calculation: Record<string, unknown> | null
}

export interface TaxDepreciationSnapshot {
  method: TaxDepreciationMethod
  selectedRule: TaxDepreciationRule | null
  openingTaxValue: number
  basis: number
  deduction: number
  closingTaxValue: number
  calculation: Record<string, unknown> | null
}

export interface TaxDepreciationView {
  status:
    | 'needs_previous_period'
    | 'needs_period_history'
    | 'needs_method'
    | 'needs_opening_value'
    | 'needs_rule'
    | 'ready'
  method: TaxDepreciationMethod | null
  selectedRule: TaxDepreciationRule | null
  methodLocked: boolean
  openingTaxValue: number | null
  openingSource: 'saved' | 'previous_period' | 'previous_period_required' | 'manual_required'
  periodMonths: number
  eligibleAssetCount: number
  excludedAssetCount: number
  excludedCategories: AssetCategory[]
  cohortHistoryComplete: boolean
  incompleteCohortCount: number
  result: TaxDepreciationResult | null
  snapshot: TaxDepreciationSnapshot | null
  isStale: boolean
}

export interface SaveTaxDepreciationInput {
  method: TaxDepreciationMethod
  selectedRule?: TaxDepreciationRule
  openingTaxValue?: number
  electedDeduction: number
  bookConformityConfirmed?: boolean
}

export type PreviewTaxDepreciationInput = Omit<
  SaveTaxDepreciationInput,
  'electedDeduction' | 'bookConformityConfirmed'
>

export class TaxDepreciationValidationError extends Error {}
export class TaxDepreciationPeriodLockedError extends Error {}

// Literal select string at each call site: the no-phantom-columns guard can only
// verify columns it can resolve statically.

export async function loadTaxDepreciationView(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<TaxDepreciationView> {
  const [periodResult, assets] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select(
        'id, name, period_start, period_end, previous_period_id, is_closed, locked_at, closing_entry_id, tax_depreciation_method, tax_depreciation_rule, tax_depreciation_opening_value, tax_depreciation_base, tax_depreciation_deduction, tax_depreciation_closing_value, tax_depreciation_calculation'
      )
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    listAssets(supabase, companyId),
  ])

  if (periodResult.error || !periodResult.data) throw new Error('Fiscal period not found')

  const current = periodResult.data as TaxPeriodRow
  const periodsResult = await supabase
    .from('fiscal_periods')
    .select(
        'id, name, period_start, period_end, previous_period_id, is_closed, locked_at, closing_entry_id, tax_depreciation_method, tax_depreciation_rule, tax_depreciation_opening_value, tax_depreciation_base, tax_depreciation_deduction, tax_depreciation_closing_value, tax_depreciation_calculation'
      )
    .eq('company_id', companyId)
    .lte('period_end', current.period_end)
    .order('period_start', { ascending: true })
  if (periodsResult.error) {
    throw new Error(`Failed to load fiscal period history: ${periodsResult.error.message}`)
  }
  const periods = (periodsResult.data ?? []) as TaxPeriodRow[]
  const currentIndex = periods.findIndex((period) => period.id === current.id)
  const previousPeriod = findImmediatePreviousTaxPeriod(current, periods)
  const previousSnapshot = previousPeriod ? snapshotFromPeriod(previousPeriod) : null
  const openingState = resolveTaxDepreciationOpening(
    snapshotFromPeriod(current),
    previousSnapshot,
    previousPeriod !== null,
  )
  const missingPreviousSnapshot = openingState.source === 'previous_period_required'

  const previousMethod = previousSnapshot?.method ?? null
  const snapshot = snapshotFromPeriod(current)
  const method = snapshot?.method ?? previousMethod
  const selectedRule = snapshot?.selectedRule ?? null
  const methodLocked = previousSnapshot !== null
  const openingTaxValue = openingState.value
  const openingSource = openingState.source

  const population = buildTaxDepreciationPopulation(assets, current, periods, currentIndex)
  let result: TaxDepreciationResult | null = null
  if (
    method
    && openingTaxValue !== null
    && (method === 'restvarde' || selectedRule)
    && !(
      method === 'rakenskapsenlig'
      && selectedRule === 'kompletteringsregel_20'
      && !population.cohortHistoryComplete
    )
  ) {
    const baseInput = {
      method,
      selectedRule: method === 'rakenskapsenlig' ? selectedRule ?? undefined : undefined,
      openingTaxValue,
      additions: population.additions,
      disposals: population.disposals,
      periodMonths: population.periodMonths,
      cohorts: population.cohorts,
    }
    try {
      result = computeTaxDepreciation({ ...baseInput, electedDeduction: snapshot?.deduction })
    } catch (error) {
      // A saved election can exceed the statutory maximum when the
      // predecessor's closing value later changed. The view must surface
      // that as a stale snapshot, not crash: recompute the statutory result
      // and let the snapshot comparison flag the divergence.
      if (!(error instanceof Error && /electedDeduction/.test(error.message))) throw error
      result = computeTaxDepreciation(baseInput)
    }
  }

  const status = missingPreviousSnapshot
    ? 'needs_previous_period'
    : !method
    ? 'needs_method'
    : openingTaxValue === null
      ? 'needs_opening_value'
      : method === 'rakenskapsenlig'
          && selectedRule === 'kompletteringsregel_20'
          && !population.cohortHistoryComplete
        ? 'needs_period_history'
      : method === 'rakenskapsenlig' && !selectedRule
        ? 'needs_rule'
        : 'ready'

  return {
    status,
    method,
    selectedRule,
    methodLocked,
    openingTaxValue,
    openingSource,
    periodMonths: population.periodMonths,
    eligibleAssetCount: population.eligibleAssetCount,
    excludedAssetCount: population.excludedAssetCount,
    excludedCategories: population.excludedCategories,
    cohortHistoryComplete: population.cohortHistoryComplete,
    incompleteCohortCount: population.incompleteCohortCount,
    result,
    snapshot,
    isStale: snapshot !== null && (result === null || !taxDepreciationSnapshotMatches(snapshot, result)),
  }
}

export async function saveTaxDepreciationElection(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: SaveTaxDepreciationInput,
): Promise<TaxDepreciationView> {
  const currentView = await loadTaxDepreciationView(supabase, companyId, fiscalPeriodId)
  if (currentView.openingSource === 'previous_period_required') {
    throw new TaxDepreciationValidationError(
      'Spara skattemässig avskrivning för närmast föregående räkenskapsår först.',
    )
  }
  if (currentView.methodLocked && currentView.method && currentView.method !== input.method) {
    throw new TaxDepreciationValidationError(
      'Skattemässig avskrivningsmetod kan inte bytas efter ett sparat tidigare år utan en särskild övergångsbedömning.',
    )
  }
  if (input.method === 'rakenskapsenlig' && !input.selectedRule) {
    throw new TaxDepreciationValidationError('Välj 30-procentsregeln eller 20-procentsregeln.')
  }
  if (input.method === 'restvarde' && input.selectedRule) {
    throw new TaxDepreciationValidationError(
      'Restvärdeavskrivning har ingen kompletteringsregel.',
    )
  }
  if (!Number.isFinite(input.electedDeduction) || input.electedDeduction < 0) {
    throw new TaxDepreciationValidationError('Årets faktiska avdrag måste vara 0 kr eller mer.')
  }
  if (input.method === 'rakenskapsenlig' && input.bookConformityConfirmed !== true) {
    throw new TaxDepreciationValidationError(
      'Bekräfta att avdraget motsvarar bokslutets totala avskrivning.',
    )
  }

  const openingTaxValue = currentView.openingSource === 'previous_period'
    ? currentView.openingTaxValue
    : input.openingTaxValue ?? currentView.openingTaxValue
  if (openingTaxValue === null || openingTaxValue === undefined) {
    throw new TaxDepreciationValidationError(
      'Ange skattemässigt värde vid årets ingång innan beräkningen sparas.',
    )
  }
  if (currentView.openingSource === 'previous_period'
      && input.openingTaxValue !== undefined
      && roundOre(input.openingTaxValue) !== roundOre(openingTaxValue)) {
    throw new TaxDepreciationValidationError(
      'Ingående skattemässigt värde hämtas från föregående sparade år och kan inte skrivas över.',
    )
  }

  let calculationView: TaxDepreciationView
  try {
    calculationView = await calculateWithElection(
      supabase,
      companyId,
      fiscalPeriodId,
      input.method,
      input.selectedRule,
      openingTaxValue,
      input.electedDeduction,
    )
  } catch (error) {
    if (error instanceof Error && /electedDeduction/.test(error.message)) {
      throw new TaxDepreciationValidationError(
        'Årets faktiska avdrag får inte överstiga högsta avdrag enligt den valda regeln.',
      )
    }
    throw error
  }
  if (!calculationView.result) throw new Error('Tax depreciation calculation was not produced')
  const result = calculationView.result
  const calculation = {
    version: 2,
    saved_by: userId,
    saved_at: new Date().toISOString(),
    period_months: result.periodMonths,
    additions: result.additions,
    disposals: result.disposals,
    excess_disposals: result.excessDisposals,
    maximum_deduction: result.maximumDeduction,
    elected_deduction: result.deduction,
    book_conformity_confirmed:
      input.method === 'rakenskapsenlig' ? input.bookConformityConfirmed === true : null,
    alternatives: result.alternatives,
    cohorts: result.cohorts,
    eligible_asset_count: calculationView.eligibleAssetCount,
    excluded_asset_count: calculationView.excludedAssetCount,
    excluded_categories: calculationView.excludedCategories,
    cohort_history_complete: calculationView.cohortHistoryComplete,
    incomplete_cohort_count: calculationView.incompleteCohortCount,
  }

  const { data: savedPeriod, error: saveError } = await supabase
    .from('fiscal_periods')
    .update({
      tax_depreciation_method: input.method,
      tax_depreciation_rule: input.method === 'rakenskapsenlig' ? input.selectedRule : null,
      tax_depreciation_opening_value: result.openingTaxValue,
      tax_depreciation_base: result.basis,
      tax_depreciation_deduction: result.deduction,
      tax_depreciation_closing_value: result.closingTaxValue,
      tax_depreciation_calculation: calculation,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .eq('is_closed', false)
    .is('locked_at', null)
    .is('closing_entry_id', null)
    .select('id')
    .maybeSingle()
  if (saveError) {
    if (/locked for tax depreciation/i.test(saveError.message)) {
      throw new TaxDepreciationPeriodLockedError('Fiscal period is locked')
    }
    if (
      /later fiscal period|previous fiscal period|opening value must equal|method must match/i
        .test(saveError.message)
    ) {
      throw new TaxDepreciationValidationError(
        'Skattemässig avskrivning kan inte ändras eftersom räkenskapsårskedjan skulle brytas.',
      )
    }
    throw new Error(`Failed to save tax depreciation: ${saveError.message}`)
  }
  if (!savedPeriod) throw new TaxDepreciationPeriodLockedError('Fiscal period is locked')

  return loadTaxDepreciationView(supabase, companyId, fiscalPeriodId)
}

export async function previewTaxDepreciationElection(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: PreviewTaxDepreciationInput,
): Promise<TaxDepreciationView> {
  const currentView = await loadTaxDepreciationView(supabase, companyId, fiscalPeriodId)
  if (currentView.openingSource === 'previous_period_required') {
    throw new TaxDepreciationValidationError(
      'Spara skattemässig avskrivning för närmast föregående räkenskapsår först.',
    )
  }
  if (currentView.methodLocked && currentView.method && currentView.method !== input.method) {
    throw new TaxDepreciationValidationError(
      'Skattemässig avskrivningsmetod kan inte bytas efter ett sparat tidigare år utan en särskild övergångsbedömning.',
    )
  }
  if (input.method === 'rakenskapsenlig' && !input.selectedRule) {
    throw new TaxDepreciationValidationError('Välj 30-procentsregeln eller 20-procentsregeln.')
  }
  if (input.method === 'restvarde' && input.selectedRule) {
    throw new TaxDepreciationValidationError(
      'Restvärdeavskrivning har ingen kompletteringsregel.',
    )
  }

  const openingTaxValue = currentView.openingSource === 'previous_period'
    ? currentView.openingTaxValue
    : input.openingTaxValue ?? currentView.openingTaxValue
  if (openingTaxValue === null || openingTaxValue === undefined) {
    throw new TaxDepreciationValidationError(
      'Ange skattemässigt värde vid årets ingång innan beräkningen förhandsgranskas.',
    )
  }
  return calculateWithElection(
    supabase,
    companyId,
    fiscalPeriodId,
    input.method,
    input.selectedRule,
    openingTaxValue,
  )
}

async function calculateWithElection(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  method: TaxDepreciationMethod,
  selectedRule: TaxDepreciationRule | undefined,
  openingTaxValue: number,
  electedDeduction?: number,
): Promise<TaxDepreciationView> {
  const view = await loadTaxDepreciationView(supabase, companyId, fiscalPeriodId)
  const [periodResult, assets, periodsResult] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select(
        'id, name, period_start, period_end, previous_period_id, is_closed, locked_at, closing_entry_id, tax_depreciation_method, tax_depreciation_rule, tax_depreciation_opening_value, tax_depreciation_base, tax_depreciation_deduction, tax_depreciation_closing_value, tax_depreciation_calculation'
      )
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    listAssets(supabase, companyId),
    supabase
      .from('fiscal_periods')
      .select(
        'id, name, period_start, period_end, previous_period_id, is_closed, locked_at, closing_entry_id, tax_depreciation_method, tax_depreciation_rule, tax_depreciation_opening_value, tax_depreciation_base, tax_depreciation_deduction, tax_depreciation_closing_value, tax_depreciation_calculation'
      )
      .eq('company_id', companyId)
      .order('period_start', { ascending: true }),
  ])
  if (periodResult.error || !periodResult.data) throw new Error('Fiscal period not found')
  if (periodsResult.error) throw new Error(`Failed to load fiscal period history: ${periodsResult.error.message}`)
  const current = periodResult.data as TaxPeriodRow
  const periods = (periodsResult.data ?? []) as TaxPeriodRow[]
  const population = buildTaxDepreciationPopulation(
    assets,
    current,
    periods,
    periods.findIndex((period) => period.id === current.id),
  )
  if (
    method === 'rakenskapsenlig'
    && selectedRule === 'kompletteringsregel_20'
    && !population.cohortHistoryComplete
  ) {
    throw new TaxDepreciationValidationError(
      'Kompletteringsregeln kräver fullständig räkenskapsårshistorik för alla kvarvarande anskaffningskohorter.',
    )
  }
  return {
    ...view,
    status: 'ready',
    method,
    selectedRule: method === 'rakenskapsenlig' ? selectedRule ?? null : null,
    openingTaxValue,
    result: computeTaxDepreciation({
      method,
      selectedRule: method === 'rakenskapsenlig' ? selectedRule : undefined,
      openingTaxValue,
      additions: population.additions,
      disposals: population.disposals,
      periodMonths: population.periodMonths,
      cohorts: population.cohorts,
      electedDeduction,
    }),
    eligibleAssetCount: population.eligibleAssetCount,
    excludedAssetCount: population.excludedAssetCount,
    excludedCategories: population.excludedCategories,
    cohortHistoryComplete: population.cohortHistoryComplete,
    incompleteCohortCount: population.incompleteCohortCount,
  }
}

export function findImmediatePreviousTaxPeriod(
  current: TaxPeriodRow,
  periods: TaxPeriodRow[],
): TaxPeriodRow | null {
  if (current.previous_period_id) {
    const linked = periods.find((period) => period.id === current.previous_period_id) ?? null
    return linked && periodsAreAdjacent(linked, current) ? linked : null
  }

  const currentStart = new Date(`${current.period_start}T00:00:00Z`)
  currentStart.setUTCDate(currentStart.getUTCDate() - 1)
  const adjacentEnd = currentStart.toISOString().slice(0, 10)
  return periods.find((period) => period.period_end === adjacentEnd) ?? null
}

export function resolveTaxDepreciationOpening(
  currentSnapshot: TaxDepreciationSnapshot | null,
  previousSnapshot: TaxDepreciationSnapshot | null,
  hasPreviousPeriod: boolean,
): { value: number | null; source: TaxDepreciationView['openingSource'] } {
  if (previousSnapshot) {
    return { value: previousSnapshot.closingTaxValue, source: 'previous_period' }
  }
  if (hasPreviousPeriod) {
    return { value: null, source: 'previous_period_required' }
  }
  if (currentSnapshot) {
    return { value: currentSnapshot.openingTaxValue, source: 'saved' }
  }
  return { value: null, source: 'manual_required' }
}

export function buildTaxDepreciationPopulation(
  assets: Asset[],
  current: TaxPeriodRow,
  periods: TaxPeriodRow[],
  currentIndex: number,
): {
  additions: number
  disposals: number
  cohorts: TaxDepreciationCohort[]
  periodMonths: number
  eligibleAssetCount: number
  excludedAssetCount: number
  excludedCategories: AssetCategory[]
  cohortHistoryComplete: boolean
  incompleteCohortCount: number
} {
  const eligibleCategories = new Set<AssetCategory>(TAX_DEPRECIATION_CATEGORIES)
  const acquiredByEnd = assets.filter((asset) => asset.acquisition_date <= current.period_end)
  const heldAtEnd = acquiredByEnd.filter(
    (asset) => !asset.disposed_at || asset.disposed_at > current.period_end,
  )
  const eligibleHeld = heldAtEnd.filter((asset) => eligibleCategories.has(asset.category))
  const excluded = heldAtEnd.filter((asset) => !eligibleCategories.has(asset.category))
  const additions = roundOre(
    eligibleHeld
      .filter((asset) => asset.acquisition_date >= current.period_start)
      .reduce((sum, asset) => sum + Number(asset.acquisition_cost), 0),
  )
  const disposals = roundOre(
    acquiredByEnd
      .filter(
        (asset) =>
          eligibleCategories.has(asset.category)
          && asset.acquisition_date < current.period_start
          && asset.disposed_at !== null
          && asset.disposed_at >= current.period_start
          && asset.disposed_at <= current.period_end,
      )
      .reduce(
        (sum, asset) =>
          sum
          + Math.max(
            0,
            Number(asset.disposed_proceeds ?? 0) - Number(asset.disposed_proceeds_vat ?? 0),
          ),
        0,
      ),
  )

  const cohortMap = new Map<string, TaxDepreciationCohort>()
  let incompleteCohortCount = 0
  for (const asset of eligibleHeld) {
    const acquisitionIndex = periods.findIndex(
      (period) =>
        asset.acquisition_date >= period.period_start
        && asset.acquisition_date <= period.period_end,
    )
    const cohortPeriods = acquisitionIndex >= 0 && currentIndex >= acquisitionIndex
      ? periods.slice(acquisitionIndex, currentIndex + 1)
      : []
    const completeHistory = cohortPeriods.length > 0
      && cohortPeriods[cohortPeriods.length - 1]?.id === current.id
      && cohortPeriods.every(
        (period, index) => index === 0 || periodsAreAdjacent(cohortPeriods[index - 1], period),
      )
    if (!completeHistory) {
      incompleteCohortCount += 1
      continue
    }
    const elapsedMonths = cohortPeriods.reduce(
      (sum, period) => sum + fiscalPeriodMonths(period.period_start, period.period_end),
      0,
    )
    const label = periods[acquisitionIndex].name
    const key = `${label}:${elapsedMonths}`
    const existing = cohortMap.get(key)
    cohortMap.set(key, {
      label,
      elapsedMonths,
      acquisitionCost: roundOre((existing?.acquisitionCost ?? 0) + Number(asset.acquisition_cost)),
    })
  }

  return {
    additions,
    disposals,
    cohorts: [...cohortMap.values()].sort((a, b) => a.elapsedMonths - b.elapsedMonths),
    periodMonths: fiscalPeriodMonths(current.period_start, current.period_end),
    eligibleAssetCount: eligibleHeld.length,
    excludedAssetCount: excluded.length,
    excludedCategories: [...new Set(excluded.map((asset) => asset.category))],
    cohortHistoryComplete: incompleteCohortCount === 0,
    incompleteCohortCount,
  }
}

function periodsAreAdjacent(previous: TaxPeriodRow, current: TaxPeriodRow): boolean {
  const nextDay = new Date(`${previous.period_end}T00:00:00Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  return nextDay.toISOString().slice(0, 10) === current.period_start
}

function snapshotFromPeriod(period: TaxPeriodRow): TaxDepreciationSnapshot | null {
  if (
    !period.tax_depreciation_method
    || period.tax_depreciation_opening_value === null
    || period.tax_depreciation_base === null
    || period.tax_depreciation_deduction === null
    || period.tax_depreciation_closing_value === null
  ) return null
  return {
    method: period.tax_depreciation_method,
    selectedRule: period.tax_depreciation_rule,
    openingTaxValue: Number(period.tax_depreciation_opening_value),
    basis: Number(period.tax_depreciation_base),
    deduction: Number(period.tax_depreciation_deduction),
    closingTaxValue: Number(period.tax_depreciation_closing_value),
    calculation: period.tax_depreciation_calculation,
  }
}

export function taxDepreciationSnapshotMatches(
  snapshot: TaxDepreciationSnapshot,
  result: TaxDepreciationResult,
): boolean {
  return snapshot.method === result.method
    && snapshot.selectedRule === result.selectedRule
    && roundOre(snapshot.openingTaxValue) === result.openingTaxValue
    && roundOre(snapshot.basis) === result.basis
    && roundOre(snapshot.deduction) === result.deduction
    && roundOre(snapshot.closingTaxValue) === result.closingTaxValue
}
