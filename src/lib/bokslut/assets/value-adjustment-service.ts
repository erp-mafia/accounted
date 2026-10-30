/**
 * Nedskrivning and its reversal for one asset (ÅRL 4 kap. 5 §, K3 27): the
 * plan the approver sees and the posting.
 *
 * The caller states the återvinningsvärde (recoverable amount, K3 27.5) on a
 * balansdag and why; the amount follows from the register:
 *   - a write-down takes the carrying amount (cost less opening, posted
 *     depreciation and the net write-down so far) down to the recoverable
 *     amount (27.2), only when it is lower;
 *   - a reversal raises it towards the recoverable amount, at most by the
 *     write-down outstanding and never above what the asset would have been
 *     carried at after depreciation had it never been written down (27.15),
 *     and never for goodwill (ÅRL 4:5 tredje stycket).
 * A component asset is tested as a whole and the amount is spread over its
 * active components by carrying amount (27.13 b), a reversal by each one's
 * write-down left (27.17). Cash-generating units across assets are out of
 * scope: one asset at a time.
 *
 * The voucher is dated the balansdag, after the year's depreciation is
 * posted (the test is on the carrying amount after it). Later years plan
 * what is left over the remaining life (K3 27.15 kommentar), which the unit
 * engine does from the write-down rows (asset-units.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { AssetValueAdjustmentBlockedError } from '@/lib/bookkeeping/errors'
import { linkBasisColumns } from '@/lib/links/stamp'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { AssetAlreadyDisposedError, AssetNotFoundError, getAsset } from './asset-service'
import { depreciationStartOf, isLand, plainAssetUnit, usesUnitEngine } from './asset-units'
import {
  activeComponentsOf,
  computeComponentDepreciation,
  computeUnitCharge,
  hasComponents,
  historyCompleteFrom,
  planAnchor,
} from './component-depreciation'
import { loadComponentSplits, postedByComponent } from './component-history'
import { computeAnnualDepreciation, openingDepreciationOf, postedDepreciationHistory } from './depreciation-engine'
import { addDaysIso, addMonthsIso, monthsBetween } from './plan-calendar'
import { effectiveAdjustments, writtenDownByKey } from './value-adjustments'
import { impairmentAccountsFor, isGoodwill } from './impairment-accounts'
import type { Asset, CreateJournalEntryLineInput, FiscalPeriod, JournalEntry } from '@/types'

export type ValueAdjustmentKind = 'impairment' | 'impairment_reversal'

export interface ValueAdjustmentInput {
  kind: ValueAdjustmentKind
  /** The fiscal year whose balansdag (last day) the test is made on. */
  fiscal_period_id: string
  /** Återvinningsvärde on the balansdag, for the asset as a whole (K3 27.5). */
  recoverable_amount: number
  /** The indication and how the recoverable amount was assessed (K3 27.3). */
  reason: string
}

interface PeriodRow {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

interface ScheduleRow {
  id: string
  fiscal_period_id: string
  planned_depreciation: number | string
  journal_entry_id: string | null
}

/** One depreciation unit's figures on the balansdag. */
interface UnitFigures {
  /** Component id, or the asset id for an asset depreciated as a whole. */
  key: string
  name: string
  componentId: string | null
  carrying: number
  writtenDown: number
  /** What the unit would be carried at had it never been written down (27.15). */
  unimpairedCarrying: number
}

export interface ValueAdjustmentPreview {
  asset: Asset
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  kind: ValueAdjustmentKind
  adjustmentDate: string
  recoverableAmount: number
  carryingAmountBefore: number
  amount: number
  carryingAmountAfter: number
  expenseAccount: string
  accumulatedAccount: string
  /** Per component for a component asset; absent otherwise. */
  components?: Array<{ component_id: string; name: string; amount: number }>
  lines: CreateJournalEntryLineInput[]
}

/** The straight-line depreciation an unimpaired plan has charged through a day. */
function plannedThrough(
  unit: { cost: number; salvage: number; opening: number; anchor: string; lifeMonths: number | null; start: string },
  through: string,
): number {
  if (unit.lifeMonths === null || unit.lifeMonths <= 0) return 0
  const base = roundOre(unit.cost - unit.salvage - unit.opening)
  if (base <= 0) return 0
  const lifeEnd = addMonthsIso(unit.start, unit.lifeMonths)
  const total = monthsBetween(unit.anchor, lifeEnd)
  if (total <= 0) return base
  const elapsed = monthsBetween(unit.anchor, addDaysIso(through, 1))
  return roundOre(base * Math.min(1, elapsed / total))
}

/**
 * `total` spread over units by weight, each share at most its cap, in öre;
 * the rounding remainder goes to the unit with the most room.
 */
export function allocateByWeight(
  total: number,
  units: ReadonlyArray<{ key: string; weight: number; cap: number }>,
): Map<string, number> {
  const out = new Map<string, number>()
  const weighted = units.filter((unit) => unit.weight > 0 && unit.cap > 0)
  const weightSum = weighted.reduce((sum, unit) => sum + unit.weight, 0)
  if (weightSum <= 0) return out
  let allocated = 0
  for (const unit of weighted) {
    const share = Math.min(unit.cap, roundOre((total * unit.weight) / weightSum))
    out.set(unit.key, share)
    allocated = roundOre(allocated + share)
  }
  let remainder = roundOre(total - allocated)
  for (const unit of [...weighted].sort((a, b) => (b.cap - (out.get(b.key) ?? 0)) - (a.cap - (out.get(a.key) ?? 0)))) {
    if (Math.abs(remainder) < 0.005) break
    const current = out.get(unit.key) ?? 0
    const next = roundOre(Math.min(unit.cap, Math.max(0, current + remainder)))
    remainder = roundOre(remainder - (next - current))
    out.set(unit.key, next)
  }
  return out
}

async function loadContext(supabase: SupabaseClient, companyId: string, assetId: string) {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()
  if (asset.disposed_at) throw new AssetAlreadyDisposedError()
  let periods: PeriodRow[]
  let schedules: ScheduleRow[]
  try {
    ;[periods, schedules] = await Promise.all([
      fetchAllRows<PeriodRow>(({ from, to }) =>
        supabase
          .from('fiscal_periods')
          .select('id, period_start, period_end, is_closed, locked_at')
          .eq('company_id', companyId)
          .order('period_start', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<ScheduleRow>(({ from, to }) =>
        supabase
          .from('depreciation_schedules')
          .select('id, fiscal_period_id, planned_depreciation, journal_entry_id')
          .eq('company_id', companyId)
          .eq('asset_id', assetId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
  } catch (error) {
    throw new Error(`Failed to load the write-down context: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { asset, periods, schedules }
}

/**
 * The write-down or reversal as it would be posted, without writing
 * anything. Throws AssetValueAdjustmentBlockedError where the posting would
 * be refused, so a preview fails exactly where the real one would.
 */
export async function previewValueAdjustment(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  input: ValueAdjustmentInput,
): Promise<ValueAdjustmentPreview> {
  const { asset, periods, schedules } = await loadContext(supabase, companyId, assetId)
  const period = periods.find((row) => row.id === input.fiscal_period_id)
  if (!period) throw new Error('Fiscal period not found')
  if (period.is_closed || period.locked_at) throw new AssetValueAdjustmentBlockedError('period_locked')
  const date = period.period_end
  if (date < asset.acquisition_date) throw new AssetValueAdjustmentBlockedError('before_acquisition')
  if (input.kind === 'impairment_reversal' && isGoodwill(asset)) {
    throw new AssetValueAdjustmentBlockedError('goodwill_reversal')
  }

  const startOf = new Map(periods.map((row) => [row.id, row.period_start]))
  const posted = schedules.filter((row) => row.journal_entry_id !== null)
  if (posted.some((row) => (startOf.get(row.fiscal_period_id) ?? '') > period.period_start)) {
    throw new AssetValueAdjustmentBlockedError('later_depreciation_posted')
  }
  if (effectiveAdjustments(asset).some((row) => row.adjustment_date > date)) {
    throw new AssetValueAdjustmentBlockedError('later_adjustment')
  }

  const postedPeriods = new Set(posted.map((row) => row.fiscal_period_id))
  const before = posted.filter((row) => (startOf.get(row.fiscal_period_id) ?? '') < period.period_start)
  const isComplete = (anchor: string) => historyCompleteFrom(anchor, period.period_start, periods, postedPeriods)
  const writtenDownBefore = writtenDownByKey(asset, { before: period.period_start })
  const writtenDownNow = writtenDownByKey(asset, { through: date })
  const componentAsset = hasComponents(asset)
  const splits = componentAsset ? await loadComponentSplits(supabase, companyId, posted.map((row) => row.id)) : []

  // The year's planenlig avskrivning goes first: the test is on the carrying
  // amount after it.
  const yearPosted = postedPeriods.has(period.id)
  if (!yearPosted) {
    const priorTotal = roundOre(before.reduce((sum, row) => sum + (Number(row.planned_depreciation) || 0), 0))
    const due = componentAsset
      ? computeComponentDepreciation(asset, period, {
          posted: postedByComponent(splits, new Set(before.map((row) => row.id))),
          writtenDown: writtenDownBefore,
          isComplete,
        }).amount
      : usesUnitEngine(asset)
        ? computeUnitCharge(
            plainAssetUnit(
              asset,
              { posted: priorTotal, writtenDown: writtenDownBefore.get(asset.id) ?? 0, isComplete },
              period.period_start,
            ),
            period,
          ).amount
        : // The posted periods, so a changed life or salvage value is applied
          // prospectively exactly as the depreciation proposal applies it.
          computeAnnualDepreciation(asset, period, postedDepreciationHistory(before, periods) ?? priorTotal).amount
    if (due > 0.005) throw new AssetValueAdjustmentBlockedError('year_not_depreciated')
  }

  const postedAll = postedByComponent(splits, new Set(posted.map((row) => row.id)))
  const units: UnitFigures[] = []
  const nextYear = addDaysIso(date, 1)
  if (componentAsset) {
    for (const component of activeComponentsOf(asset)) {
      const anchor = planAnchor({ startDate: component.depreciationStartDate, opening: component.opening })
      if (component.usefulLifeMonths !== null && !historyCompleteFrom(anchor, nextYear, periods, postedPeriods)) {
        throw new AssetValueAdjustmentBlockedError('history_incomplete')
      }
      const opening = component.opening?.amount ?? 0
      const writtenDown = writtenDownNow.get(component.id) ?? 0
      const carrying = roundOre(component.cost - opening - (postedAll.get(component.id) ?? 0) - writtenDown)
      units.push({
        key: component.id,
        name: component.name,
        componentId: component.id,
        carrying,
        writtenDown,
        unimpairedCarrying: roundOre(
          component.cost -
            opening -
            plannedThrough(
              {
                cost: component.cost,
                salvage: component.salvage,
                opening,
                anchor,
                lifeMonths: component.usefulLifeMonths,
                start: component.depreciationStartDate,
              },
              date,
            ),
        ),
      })
    }
  } else {
    const opening = openingDepreciationOf(asset)
    const start = depreciationStartOf(asset)
    const anchor = planAnchor({ startDate: start, opening })
    const lifeMonths = isLand(asset) ? null : asset.useful_life_months
    if (lifeMonths !== null && !historyCompleteFrom(anchor, nextYear, periods, postedPeriods)) {
      throw new AssetValueAdjustmentBlockedError('history_incomplete')
    }
    const cost = roundOre(Number(asset.acquisition_cost))
    const postedTotal = roundOre(posted.reduce((sum, row) => sum + (Number(row.planned_depreciation) || 0), 0))
    const writtenDown = writtenDownNow.get(asset.id) ?? 0
    units.push({
      key: asset.id,
      name: asset.name,
      componentId: null,
      carrying: roundOre(cost - (opening?.amount ?? 0) - postedTotal - writtenDown),
      writtenDown,
      unimpairedCarrying: roundOre(
        cost -
          (opening?.amount ?? 0) -
          plannedThrough(
            {
              cost,
              salvage: roundOre(Number(asset.salvage_value ?? 0)),
              opening: opening?.amount ?? 0,
              anchor,
              lifeMonths,
              start,
            },
            date,
          ),
      ),
    })
  }

  const recoverable = roundOre(input.recoverable_amount)
  const carryingBefore = roundOre(units.reduce((sum, unit) => sum + unit.carrying, 0))
  let amount: number
  let allocation: Map<string, number>
  if (input.kind === 'impairment') {
    amount = roundOre(carryingBefore - recoverable)
    if (amount <= 0.005) throw new AssetValueAdjustmentBlockedError('no_write_down')
    allocation = allocateByWeight(
      amount,
      units.map((unit) => ({ key: unit.key, weight: Math.max(0, unit.carrying), cap: Math.max(0, unit.carrying) })),
    )
  } else {
    const headroom = units.map((unit) => ({
      key: unit.key,
      room: roundOre(Math.max(0, Math.min(unit.writtenDown, unit.unimpairedCarrying - unit.carrying))),
    }))
    const room = roundOre(headroom.reduce((sum, unit) => sum + unit.room, 0))
    amount = roundOre(Math.min(room, recoverable - carryingBefore))
    if (amount <= 0.005) throw new AssetValueAdjustmentBlockedError('nothing_to_reverse')
    allocation = allocateByWeight(
      amount,
      headroom.map((unit) => ({ key: unit.key, weight: unit.room, cap: unit.room })),
    )
  }

  const accounts = impairmentAccountsFor(asset)
  // A reversal goes back through the 12x8 the write-downs were booked on.
  const latestImpairment = [...effectiveAdjustments(asset)]
    .filter((row) => row.kind === 'impairment')
    .sort((a, b) => b.adjustment_date.localeCompare(a.adjustment_date) || b.created_at.localeCompare(a.created_at))[0]
  const accumulatedAccount =
    input.kind === 'impairment_reversal' && latestImpairment ? latestImpairment.accumulated_account : accounts.accumulated
  const expenseAccount = input.kind === 'impairment' ? accounts.expense : accounts.reversal

  const label = asset.name
  const lines: CreateJournalEntryLineInput[] =
    input.kind === 'impairment'
      ? [
          { account_number: expenseAccount, debit_amount: amount, credit_amount: 0, line_description: `Nedskrivning: ${label}` },
          {
            account_number: accumulatedAccount,
            debit_amount: 0,
            credit_amount: amount,
            line_description: `Ackumulerad nedskrivning: ${label}`,
          },
        ]
      : [
          {
            account_number: accumulatedAccount,
            debit_amount: amount,
            credit_amount: 0,
            line_description: `Återförd ackumulerad nedskrivning: ${label}`,
          },
          {
            account_number: expenseAccount,
            debit_amount: 0,
            credit_amount: amount,
            line_description: `Återföring av nedskrivning: ${label}`,
          },
        ]

  return {
    asset,
    fiscalPeriod: { id: period.id, period_start: period.period_start, period_end: period.period_end },
    kind: input.kind,
    adjustmentDate: date,
    recoverableAmount: recoverable,
    carryingAmountBefore: carryingBefore,
    amount,
    carryingAmountAfter: roundOre(carryingBefore + (input.kind === 'impairment' ? -amount : amount)),
    expenseAccount,
    accumulatedAccount,
    ...(componentAsset
      ? {
          components: units
            .filter((unit) => (allocation.get(unit.key) ?? 0) > 0.005)
            .map((unit) => ({ component_id: unit.key, name: unit.name, amount: allocation.get(unit.key) ?? 0 })),
        }
      : {}),
    lines,
  }
}

/** The business event of a write-down or reversal, for the posting port. Pure. */
export function valueAdjustmentBusinessEvent(args: {
  assetId: string
  kind: ValueAdjustmentKind
  amount: number
  date: string
}): BusinessEventDraft {
  const linkBasis = linkBasisColumns('user_created')
  return {
    kind: args.kind === 'impairment' ? 'asset.impaired' : 'asset.impairment_reversed',
    category: null,
    occurredOn: args.date,
    subject: { type: 'asset', id: args.assetId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('assetValueAdjustment'),
    jurisdiction: 'SE',
  }
}

export interface ValueAdjustmentResult {
  asset: Asset
  entry: JournalEntry
  preview: ValueAdjustmentPreview
}

/** Post the write-down or reversal (see the module comment). */
export async function postValueAdjustment(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: ValueAdjustmentInput,
): Promise<ValueAdjustmentResult> {
  const preview = await previewValueAdjustment(supabase, companyId, assetId, input)
  const reason = input.reason.trim()
  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId,
    event: () =>
      valueAdjustmentBusinessEvent({
        assetId,
        kind: preview.kind,
        amount: preview.amount,
        date: preview.adjustmentDate,
      }),
    input: {
      fiscal_period_id: preview.fiscalPeriod.id,
      entry_date: preview.adjustmentDate,
      description:
        preview.kind === 'impairment'
          ? `Nedskrivning: ${preview.asset.name}`
          : `Återföring av nedskrivning: ${preview.asset.name}`,
      source_type: 'system',
      lines: preview.lines,
    },
  })
  const { entry } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'commit_asset_value_adjustment',
    args: [
      draft,
      {
        asset_id: assetId,
        kind: preview.kind,
        adjustment_date: preview.adjustmentDate,
        amount: preview.amount,
        recoverable_amount: preview.recoverableAmount,
        reason,
        expense_account: preview.expenseAccount,
        accumulated_account: preview.accumulatedAccount,
        ...(preview.components
          ? { components: preview.components.map((line) => ({ component_id: line.component_id, amount: line.amount })) }
          : {}),
      },
    ],
  })
  return {
    asset: (await getAsset(supabase, companyId, assetId)) ?? preview.asset,
    entry,
    preview,
  }
}
