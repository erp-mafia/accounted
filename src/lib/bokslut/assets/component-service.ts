/**
 * The K3 component register of one asset (BFNAR 2012:1 17.4-17.5A, 17.21A):
 * add a tillkommande component, re-estimate or correct one, remove one that
 * never reached the books, and replace one.
 *
 * Registering, changing and removing a component post nothing: the
 * expenditure is already on the asset account (a supplier invoice or bank
 * row), as for createAsset. The database guards the history
 * (guard_asset_components): a component's cost, dates and opening lock once
 * its plan has posted, a posted component cannot be removed, and the asset
 * row's cost and opening are always its components' sum.
 *
 * A replacement posts one voucher (commit_asset_component_replacement): the
 * replaced component's depreciation up to the replacement date, its
 * accumulated depreciation and cost off the books, and its carrying amount
 * as a loss (övrig rörelsekostnad, K3 17.22); the replacing component is
 * registered in the same transaction.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { linkBasisColumns } from '@/lib/links/stamp'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  AssetAlreadyDisposedError,
  AssetCorrectionBlockedError,
  AssetComponentsInvalidError,
  AssetNotFoundError,
  componentInsertRow,
  disposalAccounts,
  getAsset,
} from './asset-service'
import {
  componentsOf,
  componentUnit,
  computeComponentDepreciation,
  computeUnitCharge,
  historyCompleteFrom,
  type ComponentPlan,
} from './component-depreciation'
import { loadComponentSplits, postedByComponent } from './component-history'
import { validateComponents } from './k3-components'
import { writtenDownByKey } from './value-adjustments'
import type { Asset, CreateJournalEntryLineInput, FiscalPeriod, JournalEntry, K3Component } from '@/types'

export class AssetComponentNotFoundError extends Error {
  readonly code = 'ASSET_COMPONENT_NOT_FOUND'
  constructor() {
    super('ASSET_COMPONENT_NOT_FOUND')
    this.name = 'AssetComponentNotFoundError'
  }
}

export type ComponentReplacementBlock =
  | 'later_depreciation_posted'
  | 'year_depreciated'
  | 'earlier_year_unposted'
  | 'not_active'
  | 'last_component'
  | 'no_components'
  /** A write-down is outstanding on it: reverse that first (ÅRL 4:5). */
  | 'impaired'

export class AssetComponentReplacementBlockedError extends Error {
  readonly code = 'ASSET_COMPONENT_REPLACEMENT_BLOCKED'
  constructor(readonly reason: ComponentReplacementBlock) {
    super(reason)
    this.name = 'AssetComponentReplacementBlockedError'
  }
}

/** A component as callers write it. */
export type ComponentInput = Omit<K3Component, 'component_id'>

function refusal(error: { code?: string; message: string } | null, asset: Asset): void {
  if (!error) return
  if (error.code === 'PT409' || error.code === '23514') {
    throw new AssetCorrectionBlockedError(asset.disposed_at ? 'disposed' : 'depreciation_posted')
  }
  throw new Error(`Failed to write the component register: ${error.message}`)
}

async function loadComponentAsset(supabase: SupabaseClient, companyId: string, assetId: string): Promise<Asset> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()
  if (asset.disposed_at) throw new AssetAlreadyDisposedError()
  return asset
}

function activeComponent(asset: Asset, componentId: string): ComponentPlan {
  const component = componentsOf(asset).find((candidate) => candidate.id === componentId)
  if (!component) throw new AssetComponentNotFoundError()
  if (component.derecognisedAt !== null) throw new AssetComponentReplacementBlockedError('not_active')
  return component
}

function validateOne(asset: Asset, component: ComponentInput): void {
  const { errors } = validateComponents({
    acquisition_cost: component.cost,
    acquisition_date: asset.acquisition_date,
    k3_components: [component],
  })
  if (errors.length > 0) throw new AssetComponentsInvalidError(errors)
}

/**
 * Register a tillkommande component (K3 17.5: an added part is capitalised
 * as a component of its own). The asset must already be split into
 * components: splitting an asset goes through the full list (updateAsset's
 * k3_components), so the components cover the whole cost.
 */
export async function addAssetComponent(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: ComponentInput,
): Promise<Asset> {
  const asset = await loadComponentAsset(supabase, companyId, assetId)
  const components = componentsOf(asset)
  if (!components.some((component) => component.derecognisedAt === null)) {
    throw new AssetComponentsInvalidError([
      'Tillgången har inga komponenter. Dela upp hela anskaffningsvärdet på komponenter först.',
    ])
  }
  validateOne(asset, input)
  const sortOrder = components.reduce((max, component) => Math.max(max, component.sortOrder + 1), 0)
  const { error } = await supabase
    .from('asset_components')
    .insert(componentInsertRow(asset, userId, input, sortOrder))
  refusal(error, asset)
  return (await getAsset(supabase, companyId, assetId)) ?? asset
}

/**
 * Change a component. Name, useful life and salvage value are estimates
 * applied from now on (K3 10.9-10.10); cost, dates and opening are the
 * basis and lock once the component's plan has posted (storno first).
 */
export async function updateAssetComponent(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  componentId: string,
  patch: Partial<ComponentInput>,
): Promise<Asset> {
  const asset = await loadComponentAsset(supabase, companyId, assetId)
  const stored = activeComponent(asset, componentId)
  const merged: ComponentInput = {
    name: patch.name ?? stored.name,
    cost: patch.cost ?? stored.cost,
    useful_life_months: patch.useful_life_months !== undefined ? patch.useful_life_months : stored.usefulLifeMonths,
    salvage_value: patch.salvage_value ?? stored.salvage,
    acquisition_date: patch.acquisition_date ?? stored.acquisitionDate,
    depreciation_start_date:
      patch.depreciation_start_date !== undefined
        ? patch.depreciation_start_date
        : stored.depreciationStartDate === stored.acquisitionDate
          ? null
          : stored.depreciationStartDate,
    opening_accumulated_depreciation: patch.opening_accumulated_depreciation ?? stored.opening?.amount ?? 0,
    opening_depreciation_date:
      patch.opening_depreciation_date !== undefined ? patch.opening_depreciation_date : stored.opening?.date ?? null,
  }
  validateOne(asset, merged)
  const desired = componentInsertRow(asset, asset.user_id, merged, stored.sortOrder)
  const current: Record<string, unknown> = {
    name: stored.name,
    cost: stored.cost,
    useful_life_months: stored.usefulLifeMonths,
    salvage_value: stored.salvage,
    acquisition_date: stored.acquisitionDate,
    depreciation_start_date: stored.depreciationStartDate === stored.acquisitionDate ? null : stored.depreciationStartDate,
    opening_accumulated_depreciation: stored.opening?.amount ?? 0,
    opening_depreciation_date: stored.opening?.date ?? null,
  }
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(current)) {
    const next = desired[key as keyof typeof desired]
    if (next !== value) changes[key] = next
  }
  if (Object.keys(changes).length === 0) return asset
  const { error } = await supabase
    .from('asset_components')
    .update(changes)
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .eq('id', componentId)
  refusal(error, asset)
  return (await getAsset(supabase, companyId, assetId)) ?? asset
}

/** Remove a component that never reached the books (a data-entry mistake). */
export async function deleteAssetComponent(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  componentId: string,
): Promise<Asset> {
  const asset = await loadComponentAsset(supabase, companyId, assetId)
  activeComponent(asset, componentId)
  const { error } = await supabase
    .from('asset_components')
    .delete()
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .eq('id', componentId)
  refusal(error, asset)
  return (await getAsset(supabase, companyId, assetId)) ?? asset
}

// ── Replacement (K3 17.5, 17.21A) ───────────────────────────────

export interface ReplaceComponentInput {
  /** The derecognition date: the voucher date. */
  replaced_at: string
  /** The open fiscal period containing replaced_at. */
  fiscal_period_id: string
  /** The replacing component. Null or omitted derecognises only (a part
   *  scrapped without a replacement). Its acquisition date defaults to
   *  replaced_at. */
  new_component?: ComponentInput | null
}

export interface ComponentReplacementPlan {
  lines: CreateJournalEntryLineInput[]
  componentName: string
  cost: number
  /** The component's depreciation from the year's start to replaced_at. */
  depreciationToDate: number
  /** Opening, posted and to-date depreciation, cleared from 12x9. */
  accumulatedCleared: number
  /** What leaves the books as a loss. */
  carryingAmount: number
  newComponent: ComponentInput | null
}

export interface ComponentReplacementPreview {
  asset: Asset
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  plan: ComponentReplacementPlan
}

interface ScheduleRow {
  id: string
  fiscal_period_id: string
  journal_entry_id: string | null
}

/**
 * Compute the replacement without writing anything: refuses exactly where
 * the commit would (a later or this year's depreciation already posted, an
 * earlier year still to be depreciated, the last component), so the preview
 * an approver sees is what the commit books.
 */
export async function previewComponentReplacement(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  componentId: string,
  input: ReplaceComponentInput,
): Promise<ComponentReplacementPreview> {
  const asset = await loadComponentAsset(supabase, companyId, assetId)
  const component = activeComponent(asset, componentId)
  const others = componentsOf(asset).filter(
    (candidate) => candidate.derecognisedAt === null && candidate.id !== componentId,
  )
  const newComponent = input.new_component ?? null
  if (others.length === 0 && !newComponent) throw new AssetComponentReplacementBlockedError('last_component')
  if ((writtenDownByKey(asset).get(componentId) ?? 0) > 0.005) {
    throw new AssetComponentReplacementBlockedError('impaired')
  }
  if (input.replaced_at < component.acquisitionDate) {
    throw new AssetComponentsInvalidError(['Komponenten kan inte bytas ut före sitt anskaffningsdatum.'])
  }
  if (newComponent) {
    validateOne(asset, { ...newComponent, acquisition_date: newComponent.acquisition_date ?? input.replaced_at })
  }

  let periods: Array<Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>>
  let schedules: ScheduleRow[]
  try {
    ;[periods, schedules] = await Promise.all([
      fetchAllRows<Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>>(({ from, to }) =>
        supabase
          .from('fiscal_periods')
          .select('id, period_start, period_end')
          .eq('company_id', companyId)
          .order('period_start', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      fetchAllRows<ScheduleRow>(({ from, to }) =>
        supabase
          .from('depreciation_schedules')
          .select('id, fiscal_period_id, journal_entry_id')
          .eq('company_id', companyId)
          .eq('asset_id', assetId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
  } catch (error) {
    throw new Error(`Failed to load the replacement context: ${error instanceof Error ? error.message : String(error)}`)
  }
  const fiscalPeriod = periods.find((period) => period.id === input.fiscal_period_id)
  if (!fiscalPeriod || input.replaced_at < fiscalPeriod.period_start || input.replaced_at > fiscalPeriod.period_end) {
    throw new Error('Fiscal period not found')
  }

  const posted = schedules.filter((row) => row.journal_entry_id !== null)
  const startOf = new Map(periods.map((period) => [period.id, period.period_start]))
  if (posted.some((row) => (startOf.get(row.fiscal_period_id) ?? '') > fiscalPeriod.period_start)) {
    throw new AssetComponentReplacementBlockedError('later_depreciation_posted')
  }
  const yearPosted = posted.some((row) => row.fiscal_period_id === fiscalPeriod.id)
  if (yearPosted && input.replaced_at !== fiscalPeriod.period_end) {
    throw new AssetComponentReplacementBlockedError('year_depreciated')
  }

  const splits = await loadComponentSplits(supabase, companyId, posted.map((row) => row.id))
  const postedIdsBefore = (periodStart: string) =>
    new Set(posted.filter((row) => (startOf.get(row.fiscal_period_id) ?? '') < periodStart).map((row) => row.id))
  const postedPeriods = new Set(posted.map((row) => row.fiscal_period_id))
  const historyBefore = (period: Pick<FiscalPeriod, 'period_start'>) => ({
    posted: postedByComponent(splits, postedIdsBefore(period.period_start)),
    isComplete: (anchor: string) => historyCompleteFrom(anchor, period.period_start, periods, postedPeriods),
  })

  // An earlier year whose depreciation is still to be booked would leave
  // that charge missing from what this voucher clears.
  for (const period of periods) {
    if (period.period_start >= fiscalPeriod.period_start) break
    if (postedPeriods.has(period.id)) continue
    const charge = computeComponentDepreciation(asset, period, historyBefore(period)).perComponent.find(
      (line) => line.componentId === componentId,
    )
    if (charge && charge.amount > 0) throw new AssetComponentReplacementBlockedError('earlier_year_unposted')
  }

  const postedAll = postedByComponent(splits, new Set(posted.map((row) => row.id))).get(componentId) ?? 0
  const depreciationToDate = yearPosted
    ? 0
    : computeUnitCharge(
        componentUnit(component, historyBefore(fiscalPeriod), input.replaced_at, fiscalPeriod.period_start),
        fiscalPeriod,
      ).amount
  const accumulatedCleared = roundOre((component.opening?.amount ?? 0) + postedAll + depreciationToDate)
  const carryingAmount = roundOre(component.cost - accumulatedCleared)

  const label = `${asset.name}, ${component.name}`
  const lines: CreateJournalEntryLineInput[] = []
  if (depreciationToDate > 0.005) {
    lines.push(
      {
        account_number: asset.bas_expense_account,
        debit_amount: depreciationToDate,
        credit_amount: 0,
        line_description: `Avskrivning till utbytesdag: ${label}`,
      },
      {
        account_number: asset.bas_accumulated_account,
        debit_amount: 0,
        credit_amount: depreciationToDate,
        line_description: `Ackumulerad avskrivning till utbytesdag: ${label}`,
      },
    )
  }
  if (accumulatedCleared > 0.005) {
    lines.push({
      account_number: asset.bas_accumulated_account,
      debit_amount: accumulatedCleared,
      credit_amount: 0,
      line_description: `Utbytt komponent: nollställ ackumulerad avskrivning ${label}`,
    })
  }
  lines.push({
    account_number: asset.bas_asset_account,
    debit_amount: 0,
    credit_amount: component.cost,
    line_description: `Utbytt komponent: nollställ anskaffningsvärde ${label}`,
  })
  if (carryingAmount > 0.005) {
    lines.push({
      account_number: disposalAccounts(asset.category).loss,
      debit_amount: carryingAmount,
      credit_amount: 0,
      line_description: `Redovisat värde för utbytt komponent: ${label}`,
    })
  }

  return {
    asset,
    fiscalPeriod,
    plan: {
      lines,
      componentName: component.name,
      cost: component.cost,
      depreciationToDate,
      accumulatedCleared,
      carryingAmount,
      newComponent,
    },
  }
}

/**
 * The business event of a component replacement: an asset leaving the
 * books in part (kind asset.disposed, the asset its subject), with no
 * consideration. Pure; built only while POSTING_EVENTS is on.
 */
export function componentReplacementBusinessEvent(args: {
  assetId: string
  replacedAt: string
}): BusinessEventDraft {
  const linkBasis = linkBasisColumns('user_created')
  return {
    kind: 'asset.disposed',
    category: null,
    occurredOn: args.replacedAt,
    subject: { type: 'asset', id: args.assetId },
    currency: 'SEK',
    amount: 0,
    amountSek: 0,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('assetComponentReplacement'),
    jurisdiction: 'SE',
  }
}

export interface ComponentReplacementResult {
  asset: Asset
  entry: JournalEntry
  newComponentId: string | null
  plan: ComponentReplacementPlan
}

/** Post the replacement (see the module comment). */
export async function replaceAssetComponent(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  componentId: string,
  input: ReplaceComponentInput,
): Promise<ComponentReplacementResult> {
  const { asset, fiscalPeriod, plan } = await previewComponentReplacement(
    supabase,
    companyId,
    assetId,
    componentId,
    input,
  )
  const draft = await postingPort.draftJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => componentReplacementBusinessEvent({ assetId, replacedAt: input.replaced_at }),
    input: {
      fiscal_period_id: fiscalPeriod.id,
      entry_date: input.replaced_at,
      description: `Utbyte av komponent: ${asset.name}, ${plan.componentName}`,
      source_type: 'system',
      lines: plan.lines,
    },
  })
  const { entry, newComponentId } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'commit_asset_component_replacement',
    args: [
      draft,
      {
        asset_id: assetId,
        component_id: componentId,
        derecognised_at: input.replaced_at,
        depreciation_to_date: plan.depreciationToDate,
        accumulated_cleared: plan.accumulatedCleared,
        new_component: plan.newComponent
          ? {
              name: plan.newComponent.name.trim(),
              cost: roundOre(plan.newComponent.cost),
              useful_life_months: plan.newComponent.useful_life_months,
              salvage_value: roundOre(Number(plan.newComponent.salvage_value ?? 0)),
              acquisition_date: plan.newComponent.acquisition_date ?? null,
              depreciation_start_date: plan.newComponent.depreciation_start_date ?? null,
            }
          : null,
      },
    ],
  })
  return {
    asset: (await getAsset(supabase, companyId, assetId)) ?? asset,
    entry,
    newComponentId,
    plan,
  }
}
