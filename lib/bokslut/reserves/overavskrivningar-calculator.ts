import type { SupabaseClient } from '@supabase/supabase-js'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { proposeAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { roundOre } from '@/lib/money'
import type { Asset, AssetCategory } from '@/types'
import type { ProposedDisposition } from '../types'
import {
  compute20RuleForFiscalPeriods,
  compute30Rule,
  pickLowerResidual,
  proposeOveravskrivningar,
} from './overavskrivningar-service'

const MACHINERY_RESERVE_ACCOUNT = '2153'
const RECONCILIATION_TOLERANCE = 0.01
const FULL_DEPRECIATION_MONTHS = 60

const ELIGIBLE_CATEGORIES = new Set<AssetCategory>([
  'machinery',
  'equipment',
  'vehicle',
  'computer',
  'other_tangible',
])

interface FiscalPeriodInput {
  id: string
  period_start: string
  period_end: string
}

interface FiscalPeriodCohort extends FiscalPeriodInput {
  months: number
}

export type OveravskrivningarCalculationStatus = 'ready' | 'not_applicable' | 'blocked'

export interface OveravskrivningarCalculation {
  status: OveravskrivningarCalculationStatus
  warning?: string
  proposal: ProposedDisposition | null
  currentReserve: number
  currentPeriodChange: number
  targetReserve: number
  maximumSignedChange: number
  selectedRule?: '30-regeln' | '20-regeln'
}

export interface CalculateOveravskrivningarInput {
  supabase: SupabaseClient
  companyId: string
  fiscalPeriod: FiscalPeriodInput
  entityType?: string
}

/**
 * Calculate the maximum lawful closing reserve for machinery and inventory.
 *
 * The ledger is authoritative for book value and the existing 2153 reserve.
 * The asset register supplies acquisition cohorts and disposal proceeds. The
 * two sources must reconcile before a proposal is allowed.
 */
export async function calculateOveravskrivningar(
  input: CalculateOveravskrivningarInput,
): Promise<OveravskrivningarCalculation> {
  const { supabase, companyId, fiscalPeriod } = input
  const entityType = input.entityType ?? (await loadEntityType(supabase, companyId))
  if (entityType !== 'aktiebolag') return notApplicable()

  const [trialBalance, assets, fiscalPeriods] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriod.id, {
      closingEntry: 'include',
    }),
    listAssets(supabase, companyId),
    loadFiscalPeriodCohorts(supabase, companyId, fiscalPeriod),
  ])

  const reserveRow = trialBalance.rows.find(
    (row) => row.account_number === MACHINERY_RESERVE_ACCOUNT,
  )
  const openingReserve = roundMoney(
    (reserveRow?.opening_credit ?? 0) - (reserveRow?.opening_debit ?? 0),
  )
  const currentReserve = roundMoney(
    (reserveRow?.closing_credit ?? 0) - (reserveRow?.closing_debit ?? 0),
  )
  const currentPeriodChange = roundMoney(
    (reserveRow?.period_credit ?? 0) - (reserveRow?.period_debit ?? 0),
  )

  const relevantAssets = assets.filter(
    (asset) =>
      isEligibleAsset(asset)
      && asset.acquisition_date <= fiscalPeriod.period_end
      && (!asset.disposed_at || asset.disposed_at >= fiscalPeriod.period_start),
  )
  const activeAtEnd = relevantAssets.filter(
    (asset) => !asset.disposed_at || asset.disposed_at > fiscalPeriod.period_end,
  )

  const ledgerGrossValue = roundMoney(
    trialBalance.rows
      .filter((row) => isEligibleAcquisitionAccount(row.account_number))
      .reduce(
        (sum, row) => sum + row.closing_debit - row.closing_credit,
        0,
      ),
  )
  const registerGrossValue = roundMoney(
    activeAtEnd.reduce((sum, asset) => sum + Number(asset.acquisition_cost), 0),
  )

  if (Math.abs(ledgerGrossValue - registerGrossValue) > RECONCILIATION_TOLERANCE) {
    return blocked(
      currentReserve,
      currentPeriodChange,
      'Anläggningsregistret stämmer inte mot bokförda anskaffningsvärden i 12xx. Stäm av registret innan överavskrivningar beräknas.',
    )
  }

  if (relevantAssets.length === 0) {
    if (currentReserve <= 0) return notApplicable()
    return readyCalculation({
      currentReserve,
      currentPeriodChange,
      targetReserve: 0,
      selectedRule: '20-regeln',
      computation: {
        openingReserve,
        closingBookValue: 0,
        taxResidual: 0,
        reason: 'no_remaining_assets',
      },
    })
  }

  if (relevantAssets.some((asset) => asset.depreciation_method !== 'linear')) {
    return blocked(
      currentReserve,
      currentPeriodChange,
      'Automatisk överavskrivning kräver planenlig linjär avskrivning för hela 12xx-gruppen. Tillgångar med 30 %, 20 % eller restvärdeavskrivning måste hanteras enligt samma valda skattemetod.',
    )
  }

  const annualPostings = await proposeAnnualPostings(supabase, companyId, fiscalPeriod.id)
  const pendingEligibleDepreciation = annualPostings.items.some(
    (item) => isEligibleAsset(item.asset) && !item.existingJournalEntryId,
  )
  if (pendingEligibleDepreciation) {
    return blocked(
      currentReserve,
      currentPeriodChange,
      'Bokför de planenliga avskrivningarna först. Därefter kan överavskrivningen beräknas på rätt bokfört restvärde.',
    )
  }

  const acquisitionAccounts = new Set(relevantAssets.map((asset) => asset.bas_asset_account))
  const accumulatedAccounts = new Set(
    relevantAssets.map((asset) => asset.bas_accumulated_account),
  )
  const assetRows = trialBalance.rows.filter(
    (row) =>
      acquisitionAccounts.has(row.account_number)
      || accumulatedAccounts.has(row.account_number),
  )

  const openingBookValue = roundMoney(
    assetRows.reduce(
      (sum, row) => sum + row.opening_debit - row.opening_credit,
      0,
    ),
  )
  const closingBookValue = roundMoney(
    assetRows.reduce(
      (sum, row) => sum + row.closing_debit - row.closing_credit,
      0,
    ),
  )
  if (openingBookValue < -RECONCILIATION_TOLERANCE || closingBookValue < -RECONCILIATION_TOLERANCE) {
    return blocked(
      currentReserve,
      currentPeriodChange,
      'Bokfört restvärde för maskiner och inventarier är negativt. Rätta bokföringen innan överavskrivningar beräknas.',
    )
  }

  const additions = roundMoney(
    relevantAssets
      .filter(
        (asset) =>
          asset.acquisition_date >= fiscalPeriod.period_start
          && asset.acquisition_date <= fiscalPeriod.period_end,
      )
      .reduce((sum, asset) => sum + Number(asset.acquisition_cost), 0),
  )
  const disposals = roundMoney(
    relevantAssets
      .filter(
        (asset) =>
          Boolean(asset.disposed_at)
          && asset.disposed_at! >= fiscalPeriod.period_start
          && asset.disposed_at! <= fiscalPeriod.period_end,
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

  const openingTaxValue = Math.max(0, roundMoney(openingBookValue - openingReserve))
  const rule30 = compute30Rule({
    openingBookValue: openingTaxValue,
    additions,
    disposals,
    fiscalPeriodMonths: countFiscalMonths(
      fiscalPeriod.period_start,
      fiscalPeriod.period_end,
    ),
  })

  const acquisitionCostByCohort = fiscalPeriods.map(() => 0)
  for (const asset of activeAtEnd) {
    const cohortIndex = fiscalPeriods.findIndex(
      (period) =>
        asset.acquisition_date >= period.period_start
        && asset.acquisition_date <= period.period_end,
    )
    if (cohortIndex >= 0) {
      acquisitionCostByCohort[cohortIndex] += Number(asset.acquisition_cost)
      continue
    }

    if (monthsBetween(asset.acquisition_date, fiscalPeriod.period_end) < FULL_DEPRECIATION_MONTHS) {
      return blocked(
        currentReserve,
        currentPeriodChange,
        'Tidigare räkenskapsperioder saknas för en tillgång som ännu omfattas av 20-regeln. Komplettera periodhistoriken innan överavskrivningar beräknas.',
      )
    }
  }

  const rule20 = compute20RuleForFiscalPeriods({
    acquisitionCostByPeriod: acquisitionCostByCohort,
    fiscalPeriodMonths: fiscalPeriods.map((period) => period.months),
  })
  const selected = pickLowerResidual(rule30, rule20)
  const targetReserve = Math.max(
    0,
    Math.min(closingBookValue, roundMoney(closingBookValue - selected.residual)),
  )

  return readyCalculation({
    currentReserve,
    currentPeriodChange,
    targetReserve,
    selectedRule: selected.rule,
    computation: {
      openingBookValue,
      openingReserve,
      openingTaxValue,
      additions,
      disposals,
      closingBookValue,
      rule30Residual: rule30.minimumResidual,
      rule20Residual: rule20.minimumResidual,
      taxResidual: selected.residual,
      selectedRule: selected.rule,
      targetReserve,
    },
  })
}

function readyCalculation(input: {
  currentReserve: number
  currentPeriodChange: number
  targetReserve: number
  selectedRule: '30-regeln' | '20-regeln'
  computation: Record<string, unknown>
}): OveravskrivningarCalculation {
  const maximumSignedChange = roundMoney(input.targetReserve - input.currentReserve)
  // A positive current-period posting records the user's optional deduction
  // choice. Do not propose another increase on reload. A reserve above the
  // lawful target is different: its release remains mandatory.
  const proposalChange =
    maximumSignedChange > 0 && Math.abs(input.currentPeriodChange) > RECONCILIATION_TOLERANCE
      ? 0
      : maximumSignedChange
  const proposal = proposeOveravskrivningar({
    additionalAmount: proposalChange,
    category: 'machinery_equipment',
    computation: input.computation,
  })

  return {
    status: 'ready',
    proposal,
    currentReserve: input.currentReserve,
    currentPeriodChange: input.currentPeriodChange,
    targetReserve: input.targetReserve,
    maximumSignedChange,
    selectedRule: input.selectedRule,
  }
}

function blocked(
  currentReserve: number,
  currentPeriodChange: number,
  warning: string,
): OveravskrivningarCalculation {
  return {
    status: 'blocked',
    warning,
    proposal: null,
    currentReserve,
    currentPeriodChange,
    targetReserve: currentReserve,
    maximumSignedChange: 0,
  }
}

function notApplicable(): OveravskrivningarCalculation {
  return {
    status: 'not_applicable',
    proposal: null,
    currentReserve: 0,
    currentPeriodChange: 0,
    targetReserve: 0,
    maximumSignedChange: 0,
  }
}

async function loadEntityType(supabase: SupabaseClient, companyId: string): Promise<string> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load company entity type: ${error.message}`)
  return data?.entity_type ?? 'aktiebolag'
}

async function loadFiscalPeriodCohorts(
  supabase: SupabaseClient,
  companyId: string,
  current: FiscalPeriodInput,
): Promise<FiscalPeriodCohort[]> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_end', current.period_end)
    .order('period_end', { ascending: false })
    .limit(5)
  if (error) throw new Error(`Failed to load fiscal period history: ${error.message}`)

  const periods = ((data ?? []) as FiscalPeriodInput[]).filter(
    (period, index, rows) => rows.findIndex((candidate) => candidate.id === period.id) === index,
  )
  if (!periods.some((period) => period.id === current.id)) periods.unshift(current)
  periods.sort((a, b) => b.period_end.localeCompare(a.period_end))

  return periods.slice(0, 5).map((period) => ({
    ...period,
    months: countFiscalMonths(period.period_start, period.period_end),
  }))
}

function isEligibleAsset(asset: Asset): boolean {
  return (
    ELIGIBLE_CATEGORIES.has(asset.category)
    && isEligibleAcquisitionAccount(asset.bas_asset_account)
  )
}

function isEligibleAcquisitionAccount(account: string): boolean {
  if (!/^12\d{2}$/.test(account)) return false
  const numeric = Number(account)
  if (numeric >= 1280 && numeric <= 1289) return false
  if (account === '1291') return false
  return !account.endsWith('8') && !account.endsWith('9')
}

export function countFiscalMonths(periodStart: string, periodEnd: string): number {
  const start = new Date(`${periodStart}T00:00:00Z`)
  const end = new Date(`${periodEnd}T00:00:00Z`)
  return Math.max(
    1,
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12
      + end.getUTCMonth()
      - start.getUTCMonth()
      + 1,
  )
}

function monthsBetween(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + end.getUTCMonth()
    - start.getUTCMonth()
  )
}

function roundMoney(value: number): number {
  return roundOre(value)
}
