import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { createLogger } from '@/lib/logger'
import { frameworkOnDate } from '@/lib/company/accounting-framework'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { splitGrossVat } from '@/lib/bookkeeping/gross-split'
import { roundOre } from '@/lib/money'
import type { AssetComponentSplitLine } from '@/lib/bookkeeping/engine'
import {
  componentSplitOf,
  computeAnnualDepreciation,
  openingDepreciationOf,
  postedDepreciationHistory,
} from './depreciation-engine'
import {
  activeComponentsOf,
  computeComponentDepreciation,
  computeUnitCharge,
  hasComponents,
  historyCompleteFrom,
} from './component-depreciation'
import { loadComponentSplits, postedByComponent, type ComponentSplitRow } from './component-history'
import {
  allocateOpeningToComponents,
  componentsOpeningTotal,
  componentsStateOpening,
  validateComponents,
} from './k3-components'
import {
  AssetOpeningDepreciationInvalidError,
  validateOpeningDepreciation,
} from './opening-depreciation'
import { assessJamkning, assessJamkningEligibility } from './jamkning'
import { plainAssetUnit, usesUnitEngine } from './asset-units'
import { effectiveAdjustments, writtenDownByAccount, writtenDownByKey } from './value-adjustments'
import { chartAwareDefaultAccounts, ensureAssetAccountsInChart } from './asset-chart-accounts'
import type {
  AccountingFramework,
  Asset,
  AssetAcquisitionType,
  AssetCategory,
  WritableDepreciationMethod,
  AssetDisposalType,
  FiscalPeriod,
  K3Component,
  CreateJournalEntryLineInput,
  JournalEntry,
  VatTreatment,
} from '@/types'

const log = createLogger('bokslut/asset-service')

export interface AssetAccountTriple {
  asset: string
  accumulated: string
  expense: string
}

/**
 * Default BAS account triples per category. The user can override at create
 * time; these only kick in when the form doesn't specify accounts. Every
 * account here MUST exist in BAS_REFERENCE (lib/bookkeeping/bas-data/) so the
 * engine's backfillStandardBASAccounts can seed it on a minimal chart:
 * otherwise depreciation throws AccountsNotInChartError (#755). A guard test
 * in asset-service.test.ts enforces that invariant.
 *
 * The intangible entry is the acquired pair under either framework; the
 * company's own development is opted into (OWN_DEVELOPMENT_ACCOUNTS, through
 * defaultAccountsForCategory), so a K2 company never lands on 1010.
 *
 * vehicle (1226 Bilar och transportmedel, ej för produktion) and computer
 * (1224 Datorer, ej för produktion) are inventarier under BAS 2026: both
 * accumulate on 1229 and depreciate through 7832 (Avskrivningar på
 * inventarier, verktyg och installationer). 7833/7834 are not in the standard
 * BAS catalog (removed as non-standard in #463).
 *
 * BAS 2026 splits kontogrupp 12 by production use, not by asset kind: a car or
 * a computer used FOR production is machinery (1216 Arbetsfordon / 1214
 * Datorer för produktion, both on 1219), which the machinery category already
 * covers. Non-production is the right default for a small company. 1240/1249
 * and 1250/1259, the pre-2026 bil- and datorkonton these defaults used to
 * point at, are free accounts with no kind of their own after #2413 (#2414).
 */
export const DEFAULT_ACCOUNTS_BY_CATEGORY: Record<AssetCategory, AssetAccountTriple> = {
  // A purchased intangible (licence, patent, trademark) under either
  // framework: 1010/1019 (Utvecklingsutgifter) carry the company's OWN
  // development only, which is opted into (OWN_DEVELOPMENT_ACCOUNTS).
  immaterial: { asset: '1090', accumulated: '1099', expense: '7810' },
  building: { asset: '1110', accumulated: '1119', expense: '7821' },
  // Mark is never depreciated (K2 10.29 kommentar, K3 17.4): the
  // accumulated account only ever carries a write-down (ÅRL 4:5). BAS 2026
  // has no 12x8 of its own for mark; 1118 sits in the same balance-sheet
  // post, Byggnader och mark. 7820 is never booked.
  land: { asset: '1130', accumulated: '1118', expense: '7820' },
  land_improvement: { asset: '1150', accumulated: '1159', expense: '7824' },
  machinery: { asset: '1210', accumulated: '1219', expense: '7831' },
  equipment: { asset: '1220', accumulated: '1229', expense: '7832' },
  vehicle: { asset: '1226', accumulated: '1229', expense: '7832' },
  computer: { asset: '1224', accumulated: '1229', expense: '7832' },
  other_tangible: { asset: '1290', accumulated: '1299', expense: '7839' },
}

/**
 * The company's own development expenditure capitalised under K3 (18.12, the
 * aktiveringsmodell of 18.7): BAS 1010 Utvecklingsutgifter / 1019. Excluded
 * under K2 (BFNAR 2016:10 punkt 10.4, the accounts carry k2_excluded), and
 * under K3 only for a company that has chosen the aktiveringsmodell. An
 * aktiebolag or ekonomisk förening moves the same amount from free equity to
 * a fond för utvecklingsutgifter (ÅRL 4 kap. 2 §, development-fund.ts).
 *
 * Every other intangible, under either framework, defaults to the acquired
 * pair 1090/1099 (Övriga immateriella anläggningstillgångar): putting a
 * purchased licence on 1010 is what made its fund requirement wrong.
 */
export const OWN_DEVELOPMENT_ACCOUNTS = { asset: '1010', accumulated: '1019', expense: '7810' } as const

/** BAS kontogrupp 101: balanserade utgifter för the company's own development. */
export function isOwnDevelopmentAccount(account: string | null | undefined): boolean {
  return typeof account === 'string' && /^101\d$/.test(account)
}

/**
 * Category defaults: the table, or the own-development pair when the caller
 * registers internally generated development expenditure under K3.
 */
export function defaultAccountsForCategory(
  category: AssetCategory,
  framework: AccountingFramework | null | undefined,
  options: { internallyGenerated?: boolean } = {},
): AssetAccountTriple {
  if (category === 'immaterial' && options.internallyGenerated && framework === 'k3') {
    return { ...OWN_DEVELOPMENT_ACCOUNTS }
  }
  return DEFAULT_ACCOUNTS_BY_CATEGORY[category]
}

/**
 * Why own development expenditure cannot be capitalised for this company:
 * k2 (BFNAR 2016:10 punkt 10.4 forbids it) or model (K3 18.7: the company
 * has not chosen the aktiveringsmodell). 422 OWN_DEVELOPMENT_NOT_CAPITALISED.
 */
export class AssetOwnDevelopmentRefusedError extends Error {
  readonly code = 'OWN_DEVELOPMENT_NOT_CAPITALISED'
  constructor(readonly reason: 'k2' | 'model') {
    super(
      reason === 'k2'
        ? 'Eget utvecklingsarbete får inte tas upp som tillgång enligt K2 (BFNAR 2016:10 punkt 10.4).'
        : 'Välj aktiveringsmodellen för internt upparbetade immateriella tillgångar (K3 punkt 18.7) under Inställningar, Bokföring, innan eget utvecklingsarbete tas upp som tillgång.',
    )
    this.name = 'AssetOwnDevelopmentRefusedError'
  }
}

/** Only an asset on 1010-1019 can be marked as own development (400 OWN_DEVELOPMENT_ACCOUNT). */
export class AssetOwnDevelopmentAccountError extends Error {
  readonly code = 'OWN_DEVELOPMENT_ACCOUNT'
  constructor() {
    super(
      'Bara en tillgång på konto 1010-1019 (balanserade utgifter för utvecklingsarbeten) kan markeras som eget utvecklingsarbete. Flytta den till konto 1010 först om det är eget utvecklingsarbete.',
    )
    this.name = 'AssetOwnDevelopmentAccountError'
  }
}

/**
 * The framework of the year the asset was acquired in (frameworkOnDate: a
 * later year elected K3 does not make a K2 year K3) and the company's model
 * for internally generated intangibles (companies.development_expenditure_model,
 * K3 18.7).
 */
async function loadIntangiblePolicy(
  supabase: SupabaseClient,
  companyId: string,
  acquiredOn: string | null | undefined,
): Promise<{ framework: AccountingFramework | null; model: 'expense' | 'capitalise' | null }> {
  const [framework, { data, error }] = await Promise.all([
    frameworkOnDate(supabase, companyId, acquiredOn),
    supabase.from('companies').select('development_expenditure_model').eq('id', companyId).single(),
  ])
  if (error) {
    throw new Error(`Failed to load accounting framework for company ${companyId}: ${error.message}`)
  }
  const row = data as { development_expenditure_model?: string | null } | null
  return {
    framework,
    model: row?.development_expenditure_model === 'expense' || row?.development_expenditure_model === 'capitalise'
      ? row.development_expenditure_model
      : null,
  }
}

/**
 * Refuses own development expenditure where it may not be capitalised (see
 * the error): the year the asset was acquired in must be a K3 year (BFNAR
 * 2016:10 10.4 forbids it under K2) on the aktiveringsmodell.
 */
export async function assertOwnDevelopmentAllowed(
  supabase: SupabaseClient,
  companyId: string,
  acquiredOn: string | null | undefined,
): Promise<void> {
  const policy = await loadIntangiblePolicy(supabase, companyId, acquiredOn)
  if (policy.framework !== 'k3') throw new AssetOwnDevelopmentRefusedError('k2')
  if (policy.model !== 'capitalise') throw new AssetOwnDevelopmentRefusedError('model')
}

/**
 * The defaults for a create or a category change. A purchased intangible is
 * the acquired pair 1090/1099 under either framework (lawful under K2 and
 * K3); own development needs K3 and the aktiveringsmodell
 * (assertOwnDevelopmentAllowed). Every other category follows the company's
 * chart (chartAwareDefaultAccounts, crm#1452).
 */
async function resolveDefaultAccounts(
  supabase: SupabaseClient,
  companyId: string,
  category: AssetCategory,
  options: { internallyGenerated?: boolean; acquiredOn?: string | null } = {},
): Promise<AssetAccountTriple> {
  if (category !== 'immaterial') {
    return chartAwareDefaultAccounts(supabase, companyId, category, DEFAULT_ACCOUNTS_BY_CATEGORY[category])
  }
  if (!options.internallyGenerated) return DEFAULT_ACCOUNTS_BY_CATEGORY[category]
  await assertOwnDevelopmentAllowed(supabase, companyId, options.acquiredOn)
  return { ...OWN_DEVELOPMENT_ACCOUNTS }
}

export interface CreateAssetInput {
  name: string
  category: AssetCategory
  acquisition_date: string
  /** How the asset came onto the books; a purchase unless stated. */
  acquisition_type?: AssetAcquisitionType
  acquisition_cost: number
  salvage_value?: number
  useful_life_months: number
  depreciation_method?: WritableDepreciationMethod
  restvarde_target?: null
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  /** K3 component depreciation (BFNAR 2012:1 ch.17.4). When non-null, the
   *  engine sums per-component linear depreciation. The API layer rejects
   *  writes for K2 companies with K3_REQUIRED_FOR_COMPONENTS. */
  k3_components?: K3Component[] | null
  /** Ackumulerad avskrivning booked in a previous system, per
   *  opening_depreciation_date. Registered only: never posted (it is already
   *  in the imported 12x9 balance). The schema validates the pair. */
  opening_accumulated_depreciation?: number
  opening_depreciation_date?: string | null
  /** K3 17.18: depreciation starts when the asset can be used; omitted or
   *  the acquisition date: from the acquisition date. For a component asset
   *  it is the default of the components that state none. */
  depreciation_start_date?: string | null
  /** K3 aktiveringsmodell: the company's own development expenditure
   *  (1010/1019, ÅRL 4 kap. 2 §). Refused under K2 and until the company has
   *  chosen the aktiveringsmodell (K3 18.7). */
  internally_generated?: boolean
  notes?: string
}

/**
 * The acquisition type as an insert writes it. A purchase is the column's
 * default and is left out, so creating an ordinary asset does not depend on
 * the column (the code can be live before its migration).
 */
function acquisitionTypeColumn(type: AssetAcquisitionType | undefined): { acquisition_type?: AssetAcquisitionType } {
  return type && type !== 'purchase' ? { acquisition_type: type } : {}
}

/** The stored start date: null when it is the acquisition date. */
function startDateColumn(start: string | null | undefined, acquisitionDate: string): string | null {
  return start && start > acquisitionDate ? start : null
}

/**
 * Thrown when a land asset (category 'land', mark) is given something only a
 * depreciated asset has: a useful life, a salvage value, an opening, a start
 * date or components (400 INVALID_LAND_ASSET).
 */
export class AssetLandInvalidError extends Error {
  readonly code = 'INVALID_LAND_ASSET'
  constructor() {
    super('INVALID_LAND_ASSET')
    this.name = 'AssetLandInvalidError'
  }
}

/** Whether the asset as it will be stored is a lawful land row (see AssetLandInvalidError). */
export function landRowValid(row: {
  category: AssetCategory
  useful_life_months?: number | null
  salvage_value?: number | null
  opening_accumulated_depreciation?: number | string | null
  depreciation_start_date?: string | null
  k3_components?: unknown
}): boolean {
  if (row.category !== 'land') return true
  return (
    (Number(row.salvage_value ?? 0) || 0) === 0 &&
    (Number(row.opening_accumulated_depreciation ?? 0) || 0) === 0 &&
    !row.depreciation_start_date &&
    !(Array.isArray(row.k3_components) && row.k3_components.length > 0)
  )
}

/**
 * Create a new asset. Defaults BAS accounts from the category mapping when
 * the caller doesn't override them, framework-aware for the intangible
 * category (see resolveDefaultAccounts). Does NOT post a journal entry: the
 * acquisition is assumed to already be in the books (bank payment or
 * supplier invoice). Posting an acquisition entry alongside an existing
 * payment would double-count.
 */
export async function createAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateAssetInput,
): Promise<Asset> {
  if (!landRowValid(input)) throw new AssetLandInvalidError()
  if (Array.isArray(input.k3_components) && input.k3_components.length > 0) {
    return createComponentAsset(supabase, companyId, userId, input, input.k3_components)
  }
  const defaults = await resolveDefaultAccounts(supabase, companyId, input.category, {
    internallyGenerated: input.internally_generated,
    acquiredOn: input.acquisition_date,
  })
  // An explicit own-development account is the same choice as the flag.
  if (!input.internally_generated && isOwnDevelopmentAccount(input.bas_asset_account)) {
    await assertOwnDevelopmentAllowed(supabase, companyId, input.acquisition_date)
  }
  const land = input.category === 'land'
  const row = {
    user_id: userId,
    company_id: companyId,
    name: input.name,
    category: input.category,
    acquisition_date: input.acquisition_date,
    acquisition_cost: input.acquisition_cost,
    salvage_value: input.salvage_value ?? 0,
    // Mark has no limited useful life: 0 months, never depreciated.
    useful_life_months: land ? 0 : input.useful_life_months,
    depreciation_start_date: startDateColumn(input.depreciation_start_date, input.acquisition_date),
    depreciation_method: 'linear' as const,
    restvarde_target: null,
    bas_asset_account: input.bas_asset_account ?? defaults.asset,
    bas_accumulated_account: input.bas_accumulated_account ?? defaults.accumulated,
    bas_expense_account: input.bas_expense_account ?? defaults.expense,
    // A zero amount carries no date: the DB CHECK pairs them.
    ...openingColumns(input.opening_accumulated_depreciation, input.opening_depreciation_date),
    ...acquisitionTypeColumn(input.acquisition_type),
    notes: input.notes ?? null,
    // Own development (allowed above only on K3 with the aktiveringsmodell):
    // what the fond för utvecklingsutgifter follows.
    own_development: isOwnDevelopmentAccount(input.bas_asset_account ?? defaults.asset),
  }

  // crm#1452: the row may not point at an account the chart lacks.
  await ensureAssetAccountsInChart(supabase, companyId, userId, [
    row.bas_asset_account,
    row.bas_accumulated_account,
    row.bas_expense_account,
  ])
  const { data, error } = await supabase
    .from('assets')
    .insert(row)
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

/**
 * Create an asset with K3 components (17.4): the asset row, then its
 * component rows, whose sum the database writes back onto the asset row
 * (cost, opening, k3_components). An opening amount stated for the whole
 * asset is split over components that state none
 * (allocateOpeningToComponents). Two writes over PostgREST: a failed
 * component insert removes the fresh asset again, which never reached the
 * books, so no half-registered asset is left behind.
 */
async function createComponentAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: CreateAssetInput,
  components: K3Component[],
): Promise<Asset> {
  const defaults = await resolveDefaultAccounts(supabase, companyId, input.category, {
    internallyGenerated: input.internally_generated,
    acquiredOn: input.acquisition_date,
  })
  if (!input.internally_generated && isOwnDevelopmentAccount(input.bas_asset_account)) {
    await assertOwnDevelopmentAllowed(supabase, companyId, input.acquisition_date)
  }
  // An asset-level start date is the default of components that state none.
  const assetStart = startDateColumn(input.depreciation_start_date, input.acquisition_date)
  const resolved = resolveComponentOpenings(
    assetStart
      ? components.map((component) => ({
          ...component,
          depreciation_start_date: component.depreciation_start_date ?? assetStart,
        }))
      : components,
    {
      amount: input.opening_accumulated_depreciation,
      date: input.opening_depreciation_date ?? null,
    },
    input.acquisition_date,
  )
  const accounts = {
    asset: input.bas_asset_account ?? defaults.asset,
    accumulated: input.bas_accumulated_account ?? defaults.accumulated,
    expense: input.bas_expense_account ?? defaults.expense,
  }
  // crm#1452, as for a plain asset: the row may not point at an account the
  // chart lacks.
  await ensureAssetAccountsInChart(supabase, companyId, userId, [accounts.asset, accounts.accumulated, accounts.expense])
  const { data, error } = await supabase
    .from('assets')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: input.name,
      category: input.category,
      acquisition_date: input.acquisition_date,
      acquisition_cost: roundOre(components.reduce((sum, component) => sum + component.cost, 0)),
      // The components carry the salvage values, lives and openings; the
      // asset row shows their sum once they are written.
      salvage_value: 0,
      useful_life_months: input.useful_life_months,
      depreciation_method: 'linear' as const,
      restvarde_target: null,
      bas_asset_account: accounts.asset,
      bas_accumulated_account: accounts.accumulated,
      bas_expense_account: accounts.expense,
      opening_accumulated_depreciation: 0,
      opening_depreciation_date: null,
      ...acquisitionTypeColumn(input.acquisition_type),
      notes: input.notes ?? null,
      own_development: isOwnDevelopmentAccount(accounts.asset),
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to create asset: ${error?.message ?? 'unknown'}`)
  }
  const asset = data as Asset
  const { error: componentError } = await supabase
    .from('asset_components')
    .insert(resolved.map((component, index) => componentInsertRow(asset, userId, component, index)))
  if (componentError) {
    await supabase.from('assets').delete().eq('id', asset.id).eq('company_id', companyId)
    throw new Error(`Failed to create asset components: ${componentError.message}`)
  }
  return (await getAsset(supabase, companyId, asset.id)) ?? asset
}

/**
 * The components with their openings settled: as stated per component, or
 * an amount stated for the whole asset split over them. Stating both is
 * accepted only when they agree.
 */
export function resolveComponentOpenings(
  components: K3Component[],
  assetOpening: { amount?: number | null; date?: string | null },
  assetAcquisitionDate: string,
): K3Component[] {
  const assetAmount = roundOre(Number(assetOpening.amount ?? 0) || 0)
  if (componentsStateOpening(components)) {
    if (assetAmount > 0 && Math.abs(componentsOpeningTotal(components) - assetAmount) > 0.005) {
      throw new AssetOpeningDepreciationInvalidError([
        {
          kind: 'exceeds_cost',
          path: 'opening_accumulated_depreciation',
          message:
            'Redan avskrivet belopp för tillgången stämmer inte med summan av komponenternas redan avskrivna belopp.',
        },
      ])
    }
    return components
  }
  if (assetAmount <= 0 || !assetOpening.date) return components
  return allocateOpeningToComponents(
    components,
    { amount: assetAmount, date: assetOpening.date },
    assetAcquisitionDate,
  )
}

/** One asset_components insert row from a component input. */
export function componentInsertRow(
  asset: Pick<Asset, 'id' | 'company_id' | 'acquisition_date'>,
  userId: string,
  component: K3Component,
  sortOrder: number,
) {
  const opening = openingColumns(component.opening_accumulated_depreciation, component.opening_depreciation_date)
  return {
    user_id: userId,
    company_id: asset.company_id,
    asset_id: asset.id,
    name: component.name.trim(),
    cost: roundOre(component.cost),
    useful_life_months: component.useful_life_months,
    salvage_value: roundOre(Number(component.salvage_value ?? 0)),
    acquisition_date: component.acquisition_date ?? asset.acquisition_date,
    depreciation_start_date: component.depreciation_start_date ?? null,
    ...opening,
    sort_order: sortOrder,
  }
}

/** Normalize the opening pair for persistence: öre-rounded amount, and no
 *  date without an amount. */
function openingColumns(
  amount: number | null | undefined,
  date: string | null | undefined,
): { opening_accumulated_depreciation: number; opening_depreciation_date: string | null } {
  const rounded = roundOre(Number(amount ?? 0) || 0)
  return {
    opening_accumulated_depreciation: rounded,
    opening_depreciation_date: rounded > 0 ? date ?? null : null,
  }
}

/*
 * Every asset read embeds the component register and the posted value
 * adjustments, with each voucher's status so a storno takes one out. The
 * embeds name their foreign keys: asset_value_adjustments references both
 * assets and asset_components, so PostgREST could otherwise see a second
 * path between them. The select is spelled out at each read (listAssets,
 * getAsset, updateAsset) so the schema guard can check its columns.
 */

export async function listAssets(
  supabase: SupabaseClient,
  companyId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Asset[]> {
  // Paginated past PostgREST's silent 1000-row cap - the depreciation engine
  // iterates this list, so truncation would silently skip assets at year-end.
  // Secondary order on id gives the stable total order .range() paging
  // requires; acquisition_date alone is not unique.
  try {
    return await fetchAllRows<Asset>(({ from, to }) => {
      let query = supabase
        .from('assets')
        .select('*, components:asset_components!asset_components_asset_id_fkey(*), value_adjustments:asset_value_adjustments!asset_value_adjustments_asset_id_fkey(id, asset_id, component_id, kind, adjustment_date, fiscal_period_id, amount, recoverable_amount, reason, expense_account, accumulated_account, journal_entry_id, created_at, journal_entry:journal_entries!asset_value_adjustments_journal_entry_id_fkey(status))')
        .eq('company_id', companyId)
        .order('acquisition_date', { ascending: true })
        .order('id', { ascending: true })

      if (options.activeOnly) {
        query = query.is('disposed_at', null)
      }

      return query.range(from, to)
    })
  } catch (err) {
    throw new Error(`Failed to list assets: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function getAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<Asset | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('*, components:asset_components!asset_components_asset_id_fkey(*), value_adjustments:asset_value_adjustments!asset_value_adjustments_asset_id_fkey(id, asset_id, component_id, kind, adjustment_date, fiscal_period_id, amount, recoverable_amount, reason, expense_account, accumulated_account, journal_entry_id, created_at, journal_entry:journal_entries!asset_value_adjustments_journal_entry_id_fkey(status))')
    .eq('id', assetId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load asset: ${error.message}`)
  return (data as Asset | null) ?? null
}


/**
 * Thrown when the caller tries to correct an asset's acquisition basis
 * (date / cost / category) after that basis has already driven postings:
 * i.e. the asset is disposed, or planenliga avskrivningar have been booked.
 * Allowing the edit would silently desync the posted vouchers from the
 * register, so the caller must reverse/storno first. The `code` field is
 * read by errorResponse() (see lib/errors/structured-errors.ts) to map this
 * to a 409.
 */
export class AssetCorrectionBlockedError extends Error {
  readonly code = 'ASSET_CORRECTION_BLOCKED'
  constructor(readonly reason: 'disposed' | 'depreciation_posted') {
    super(
      reason === 'disposed'
        ? 'Cannot correct acquisition date/cost/category of a disposed asset: reverse the disposal first.'
        : 'Cannot correct acquisition date/cost/category after depreciation has been posted: reverse the depreciation (storno) first.',
    )
    this.name = 'AssetCorrectionBlockedError'
  }
}

export interface UpdateAssetInput {
  name?: string
  notes?: string | null
  /** How the asset came onto the books. Not part of the depreciation basis:
   *  it decides the row of the note the cost is shown on, nothing booked. */
  acquisition_type?: AssetAcquisitionType
  /** "Correction" fields: they redefine the depreciation basis, so changing
   *  them implies the original entry was wrong. Only permitted while the asset
   *  is neither disposed nor depreciated (updateAsset() enforces; throws
   *  AssetCorrectionBlockedError otherwise). Use the disposal/storno flow for a
   *  real change to an already-depreciated asset. */
  category?: AssetCategory
  acquisition_date?: string
  acquisition_cost?: number
  /** Salvage value, useful life, method, accounts: editable as long as the
   *  asset isn't disposed yet (DB trigger enforces this beyond the API).
   *  Unlike the correction fields above, revising useful life or method is a
   *  legitimate *prospective* change and stays allowed after depreciation. */
  salvage_value?: number
  useful_life_months?: number
  depreciation_method?: WritableDepreciationMethod
  restvarde_target?: null
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  /** K3 component breakdown. Pass null to clear an existing breakdown
   *  (engine then falls back to ordinary linear depreciation). The route handler
   *  enforces accounting_framework='k3' + sum validation before delegating. */
  k3_components?: K3Component[] | null
  /** Opening accumulated depreciation from a previous system. Part of the
   *  depreciation basis, so it is a correction field: editable only while
   *  nothing is posted against the asset. 0 clears it (and its date). */
  opening_accumulated_depreciation?: number
  opening_depreciation_date?: string | null
  /** K3 17.18 start date; null or the acquisition date: from the
   *  acquisition date. Part of the depreciation basis (locked once posted). */
  depreciation_start_date?: string | null
  /** Mark (or unmark) an asset on 101x as the company's own development
   *  (K3 18.7): what the fond för utvecklingsutgifter follows. Written by
   *  set_asset_own_development, which records who changed it. */
  own_development?: boolean
}

/**
 * True when the asset's plan has driven a posting: a depreciation_schedules
 * row linked to a posted journal entry, or a posted nedskrivning (ÅRL 4:5).
 * `head` counts keep it cheap: we only need existence, not the rows. Used to
 * gate acquisition-basis corrections.
 */
export async function hasPostedDepreciation(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('depreciation_schedules')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
    .not('journal_entry_id', 'is', null)
  if (error) {
    throw new Error(
      `Failed to check posted depreciation for asset ${assetId}: ${error.message}`,
    )
  }
  if ((count ?? 0) > 0) return true
  // A handful of rows per asset at most: read them with their voucher status.
  const { data: adjustments, error: adjustmentError } = await supabase
    .from('asset_value_adjustments')
    .select('id, journal_entry:journal_entries!asset_value_adjustments_journal_entry_id_fkey(status)')
    .eq('company_id', companyId)
    .eq('asset_id', assetId)
  if (adjustmentError) {
    throw new Error(
      `Failed to check posted write-downs for asset ${assetId}: ${adjustmentError.message}`,
    )
  }
  return effectiveAdjustments({
    value_adjustments: (adjustments ?? []) as unknown as Asset['value_adjustments'],
  }).length > 0
}

export async function updateAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  inputParam: UpdateAssetInput,
  /** Who registers a component the patch adds; the asset's owner when omitted. */
  options: { userId?: string } = {},
): Promise<Asset> {
  // Copy so category-driven account defaults do not mutate the caller's object.
  // The own-development mark is set apart: it goes through its own audited
  // door (set_asset_own_development), not the row update.
  const { own_development: ownFlag, ...rest } = inputParam
  let input: UpdateAssetInput = rest

  // Almost every meaningful patch needs the current row (range checks, the
  // method/target biconditional, the correction guard). Load it once.
  const needsExisting =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined ||
    input.salvage_value !== undefined ||
    input.depreciation_method !== undefined ||
    input.bas_asset_account !== undefined ||
    input.bas_accumulated_account !== undefined ||
    input.bas_expense_account !== undefined ||
    input.opening_accumulated_depreciation !== undefined ||
    input.opening_depreciation_date !== undefined ||
    input.depreciation_start_date !== undefined ||
    input.useful_life_months !== undefined ||
    input.k3_components !== undefined ||
    ownFlag !== undefined
  let existing: Asset | null = null
  if (needsExisting) {
    existing = await getAsset(supabase, companyId, assetId)
    if (!existing) throw new Error('Asset not found')
  }

  // ── K3 components ─────────────────────────────────────────────────
  // A component asset's cost, salvage value and opening are the sum of its
  // components, written back by the database: the patch reaches them through
  // the components. Planned here (validated, diffed), written just before
  // the asset row, after every other check has passed.
  let componentPatch: ComponentPatchPlan | null = null
  if (existing && (input.k3_components !== undefined || hasComponents(existing))) {
    componentPatch = planComponentPatch(existing, input)
    input = componentPatch.remaining
  }

  // ── Start date and mark ───────────────────────────────────────────
  // The start date is stored only when it is after the acquisition date. A
  // component asset states it per component. Mark (category 'land') has no
  // limited life: 0 months, set here whatever the patch said, and nothing
  // else a depreciated asset has (landRowValid; the DB CHECK as well).
  if (existing) {
    if (input.depreciation_start_date !== undefined) {
      if (componentPatch?.componentAsset && input.depreciation_start_date) {
        throw new AssetComponentsInvalidError(['Ange startdatum för avskrivning per komponent.'])
      }
      input = {
        ...input,
        depreciation_start_date: startDateColumn(
          input.depreciation_start_date,
          input.acquisition_date ?? existing.acquisition_date,
        ),
      }
    }
    const finalCategory = input.category ?? existing.category
    if (finalCategory === 'land') {
      input = { ...input, useful_life_months: 0 }
    } else if (
      (existing.category === 'land' && !(Number(input.useful_life_months) > 0)) ||
      (input.useful_life_months !== undefined && !(input.useful_life_months > 0))
    ) {
      throw new AssetLandInvalidError()
    }
    const final = {
      category: finalCategory,
      salvage_value: input.salvage_value ?? Number(existing.salvage_value ?? 0),
      opening_accumulated_depreciation:
        input.opening_accumulated_depreciation ?? existing.opening_accumulated_depreciation,
      depreciation_start_date:
        input.depreciation_start_date !== undefined ? input.depreciation_start_date : existing.depreciation_start_date,
      k3_components: componentPatch ? (componentPatch.componentAsset ? [{}] : null) : existing.k3_components,
    }
    if (!landRowValid(final)) throw new AssetLandInvalidError()
  }

  // ── Correction guard ──────────────────────────────────────────────
  // acquisition_date / acquisition_cost / category redefine the depreciation
  // basis. Correcting a fresh data-entry mistake is safe, but once the basis
  // has driven postings (disposal voucher or booked avskrivningar) the edit
  // would silently desync those vouchers from the register. Force those cases
  // through reverse/storno instead.
  const touchesOpening =
    input.opening_accumulated_depreciation !== undefined ||
    input.opening_depreciation_date !== undefined
  const isCorrection =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined ||
    (input.depreciation_start_date !== undefined &&
      input.depreciation_start_date !== (existing?.depreciation_start_date ?? null))
  if ((isCorrection || touchesOpening) && existing) {
    if (existing.disposed_at) {
      throw new AssetCorrectionBlockedError('disposed')
    }
    // One predicate, the one get_asset reports as has_posted_depreciation
    // and the database enforces on the opening fields: a depreciation
    // the engine planned from this basis and posted. Only those vouchers
    // would contradict the corrected register; a planned row that was never
    // posted does not. Credits on the 12x9 account that the engine did not
    // post (imported history, an opening balance, a hand-booked avskrivning
    // or rättelse) carry no link to this row: the register accounts for
    // them through the opening amount, corrected in the same patch, and
    // refusing on them locked every migrated asset's basis (crm#1511).
    if (await hasPostedDepreciation(supabase, companyId, assetId)) {
      throw new AssetCorrectionBlockedError('depreciation_posted')
    }
  }

  // ── Opening accumulated depreciation ──────────────────────────────
  // Judged on the row as it will END UP: a patch that lowers the cost (or
  // raises the restvärde) below the stored opening amount, or adds components
  // to an asset carrying one, is refused just like a bad opening amount
  // itself. When the patch touches the opening fields, finalOpening is judged
  // as is: a cleared date must fail here, not fall back to the stored date.
  // A component asset's opening is its components' (validated per component).
  if (existing && !componentPatch?.componentAsset) {
    const finalOpening = touchesOpening
      ? openingColumns(
          input.opening_accumulated_depreciation ??
            Number(existing.opening_accumulated_depreciation ?? 0),
          input.opening_depreciation_date !== undefined
            ? input.opening_depreciation_date
            : existing.opening_depreciation_date ?? null,
        )
      : null
    const issues = validateOpeningDepreciation({
      acquisition_cost: input.acquisition_cost ?? Number(existing.acquisition_cost),
      acquisition_date: input.acquisition_date ?? existing.acquisition_date,
      salvage_value: input.salvage_value ?? Number(existing.salvage_value ?? 0),
      opening_accumulated_depreciation: finalOpening
        ? finalOpening.opening_accumulated_depreciation
        : Number(existing.opening_accumulated_depreciation ?? 0),
      opening_depreciation_date: finalOpening
        ? finalOpening.opening_depreciation_date
        : existing.opening_depreciation_date ?? null,
    })
    if (issues.length > 0) throw new AssetOpeningDepreciationInvalidError(issues)
    if (finalOpening) input = { ...input, ...finalOpening }
  }

  // ── Category change → realign BAS accounts ────────────────────────
  // The BAS triple is category-scoped (INK2R mapping + engine defaults depend
  // on it). When the category changes and the caller didn't supply explicit
  // accounts, reset the triple to the new category's defaults so the chart
  // stays aligned, mirrors createAsset()'s defaulting. Framework-aware for the
  // intangible category, so recategorizing a purchased licence to "Immateriell
  // tillgång" lands a K2 company on 1090/1099 instead of the Ej K2 pair.
  if (
    input.category !== undefined &&
    existing &&
    input.category !== existing.category &&
    input.bas_asset_account === undefined &&
    input.bas_accumulated_account === undefined &&
    input.bas_expense_account === undefined
  ) {
    const defaults = await resolveDefaultAccounts(supabase, companyId, input.category, {
      acquiredOn: input.acquisition_date ?? existing.acquisition_date,
    })
    input = {
      ...input,
      bas_asset_account: defaults.asset,
      bas_accumulated_account: defaults.accumulated,
      bas_expense_account: defaults.expense,
    }
  }

  // Moving the asset onto an own-development account (101x) is capitalising
  // own development: the same K3 aktiveringsmodell rule as a create.
  if (
    existing &&
    isOwnDevelopmentAccount(input.bas_asset_account) &&
    input.bas_asset_account !== existing.bas_asset_account
  ) {
    await assertOwnDevelopmentAllowed(supabase, companyId, input.acquisition_date ?? existing.acquisition_date)
  }

  // ── BAS account range validation ──────────────────────────────────
  // Defense-in-depth: refuse anything outside the legitimate range for the
  // asset's (possibly newly-changed) category. Validates against the final
  // category so a category+account change is checked as a unit.
  if (
    input.bas_asset_account ||
    input.bas_accumulated_account ||
    input.bas_expense_account
  ) {
    if (!existing) throw new Error('Asset not found')
    const finalCategory = input.category ?? existing.category
    const ranges = BAS_RANGES_BY_CATEGORY[finalCategory]
    if (input.bas_asset_account && !inBasRange(input.bas_asset_account, ranges.asset)) {
      throw new Error(
        `bas_asset_account ${input.bas_asset_account} is outside ${ranges.asset[0]}-${ranges.asset[1]} for ${finalCategory}`,
      )
    }
    if (
      input.bas_accumulated_account &&
      !inBasRange(input.bas_accumulated_account, ranges.accumulated)
    ) {
      throw new Error(
        `bas_accumulated_account ${input.bas_accumulated_account} is outside ${ranges.accumulated[0]}-${ranges.accumulated[1]} for ${finalCategory}`,
      )
    }
    if (
      input.bas_expense_account &&
      !inBasRange(input.bas_expense_account, ranges.expense)
    ) {
      throw new Error(
        `bas_expense_account ${input.bas_expense_account} is outside ${ranges.expense[0]}-${ranges.expense[1]} for ${finalCategory}`,
      )
    }
    // Anskaffning and ackumulerade-avskrivningar must be different accounts:
    // see CreateAssetSchema validateBasOverrides for the rationale.
    const finalAsset = input.bas_asset_account ?? existing.bas_asset_account
    const finalAccumulated = input.bas_accumulated_account ?? existing.bas_accumulated_account
    if (finalAsset === finalAccumulated) {
      throw new Error(
        'bas_asset_account and bas_accumulated_account must be different accounts',
      )
    }
  }

  // crm#1452, as on a create: an account the row moves onto (a category
  // change's defaults, an own-development account, an explicit account) must
  // be in the company's chart, added when it is a standard BAS account.
  const movedOnto = [input.bas_asset_account, input.bas_accumulated_account, input.bas_expense_account].filter(
    (account): account is string => typeof account === 'string' && account.length > 0,
  )
  if (existing && movedOnto.length > 0) {
    await ensureAssetAccountsInChart(supabase, companyId, options.userId ?? existing.user_id, movedOnto)
  }

  // The asset row first, then its components: a corrected acquisition date
  // is in place before an original component follows it (a component is
  // never acquired before its asset).
  // Own development follows the asset account: moving onto 101x is
  // capitalising own development (checked above), moving off it ends it.
  // An explicit mark in the same patch decides, on 101x only.
  const accountMoves =
    existing !== null && input.bas_asset_account !== undefined && input.bas_asset_account !== existing.bas_asset_account
  const finalAccount = input.bas_asset_account ?? existing?.bas_asset_account
  if (ownFlag === true && existing) {
    if (!isOwnDevelopmentAccount(finalAccount)) throw new AssetOwnDevelopmentAccountError()
    await assertOwnDevelopmentAllowed(supabase, companyId, input.acquisition_date ?? existing.acquisition_date)
  }
  const patch = accountMoves
    ? { ...input, own_development: isOwnDevelopmentAccount(input.bas_asset_account) && ownFlag !== false }
    : input
  let updated: Asset | null = existing
  if (Object.keys(input).length > 0 || (!componentPatch && ownFlag === undefined)) {
    const { data, error } = await supabase
      .from('assets')
      .update(patch)
      .eq('id', assetId)
      .eq('company_id', companyId)
      .select('*, components:asset_components!asset_components_asset_id_fkey(*), value_adjustments:asset_value_adjustments!asset_value_adjustments_asset_id_fkey(id, asset_id, component_id, kind, adjustment_date, fiscal_period_id, amount, recoverable_amount, reason, expense_account, accumulated_account, journal_entry_id, created_at, journal_entry:journal_entries!asset_value_adjustments_journal_entry_id_fkey(status))')
      .single()
    if (error || !data) {
      if (error?.code === 'PT409' && error.message === 'ASSET_CORRECTION_BLOCKED') {
        throw new AssetCorrectionBlockedError('depreciation_posted')
      }
      throw new Error(`Failed to update asset: ${error?.message ?? 'unknown'}`)
    }
    updated = data as Asset
  }
  if (componentPatch && existing) {
    await executeComponentPatch(supabase, companyId, existing, componentPatch, options.userId ?? existing.user_id)
    updated = (await getAsset(supabase, companyId, assetId)) ?? updated
  }
  if (ownFlag !== undefined && existing && !accountMoves && ownFlag !== (existing.own_development === true)) {
    await setOwnDevelopmentMark(supabase, companyId, assetId, ownFlag, options.userId)
    updated = (await getAsset(supabase, companyId, assetId)) ?? updated
  }
  return updated as Asset
}

/**
 * Mark or unmark an asset as own development through
 * set_asset_own_development, whose trigger writes the audit_log row with
 * who did it: the signed-in user, or for an API-key or MCP door the userId
 * and the surrounding actor.
 */
async function setOwnDevelopmentMark(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  own: boolean,
  userId: string | undefined,
): Promise<void> {
  const actor = getActor()
  const { error } = await supabase.rpc('set_asset_own_development', {
    p_company_id: companyId,
    p_asset_id: assetId,
    p_own: own,
    p_user_id: userId ?? null,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (!error) return
  if (error.message === 'OWN_DEVELOPMENT_ACCOUNT') throw new AssetOwnDevelopmentAccountError()
  if (error.message === 'OWN_DEVELOPMENT_NOT_CAPITALISED') throw new AssetOwnDevelopmentRefusedError('model')
  if (error.message === 'ASSET_NOT_FOUND') throw new AssetNotFoundError()
  throw new Error(`Kunde inte markera tillgången som eget utvecklingsarbete: ${error.message}`)
}

/** Thrown when a component breakdown fails validation (400 INVALID_K3_COMPONENTS). */
export class AssetComponentsInvalidError extends Error {
  readonly code = 'INVALID_K3_COMPONENTS'
  constructor(readonly errors: string[]) {
    super(errors.join(' '))
    this.name = 'AssetComponentsInvalidError'
  }
}

interface ComponentRowUpdate {
  id: string
  changes: Record<string, unknown>
}

export interface ComponentPatchPlan {
  /** The rest of the patch, for the asset row. */
  remaining: UpdateAssetInput
  /** True when the asset has components after the patch. */
  componentAsset: boolean
  deletes: string[]
  updates: ComponentRowUpdate[]
  inserts: Array<{ component: K3Component; sortOrder: number }>
  /** The asset's acquisition date after the patch: a new component's default. */
  finalDate: string
}

/**
 * Plan a patch of a component asset, or of an asset getting or losing its
 * components, without writing anything:
 *
 * - `k3_components` is the full list after the patch: an element with a
 *   `component_id` updates that component (only the fields that changed are
 *   written, so a renamed or re-estimated component keeps its posted
 *   basis), one without registers a new component (a tillkommande
 *   component, K3 17.5), an active component left out is removed (refused
 *   by the database once it has reached the books), null removes them all;
 * - the asset's cost follows its components; a cost given with them must
 *   equal their sum, and an asset getting components keeps the cost it has
 *   on the books unless the patch changes it;
 * - an opening given for the whole asset is split over components that
 *   state none (allocateOpeningToComponents);
 * - the asset-level cost, salvage value and opening are left out of the row
 *   update for a component asset: the database writes their sums.
 */
export function planComponentPatch(existing: Asset, input: UpdateAssetInput): ComponentPatchPlan {
  const current = activeComponentsOf(existing)
  const hadComponents = current.length > 0
  const finalDate = input.acquisition_date ?? existing.acquisition_date
  const touchesOpening =
    input.opening_accumulated_depreciation !== undefined || input.opening_depreciation_date !== undefined

  const remaining: UpdateAssetInput = { ...input }
  delete remaining.k3_components

  // The full list after the patch. A field left out of an existing
  // component keeps its stored value; null clears it.
  const storedById = new Map(current.map((component) => [component.id, component]))
  const listed: K3Component[] =
    input.k3_components === undefined
      ? current.map((component) => ({
          component_id: component.id,
          name: component.name,
          cost: component.cost,
          useful_life_months: component.usefulLifeMonths,
        }))
      : input.k3_components ?? []
  let target: K3Component[] = listed.map((component) => {
    const stored = component.component_id ? storedById.get(component.component_id) : undefined
    if (!stored) return component
    return {
      ...component,
      salvage_value: component.salvage_value ?? stored.salvage,
      // An original component moves with a corrected asset acquisition date.
      acquisition_date:
        component.acquisition_date ??
        (stored.acquisitionDate === existing.acquisition_date ? finalDate : stored.acquisitionDate),
      depreciation_start_date:
        component.depreciation_start_date !== undefined
          ? component.depreciation_start_date
          : stored.depreciationStartDate === stored.acquisitionDate
            ? null
            : stored.depreciationStartDate,
      // A new opening for the whole asset is split again below.
      ...(touchesOpening && input.k3_components === undefined
        ? { opening_accumulated_depreciation: 0, opening_depreciation_date: null }
        : {
            opening_accumulated_depreciation: component.opening_accumulated_depreciation ?? stored.opening?.amount ?? 0,
            opening_depreciation_date:
              component.opening_depreciation_date !== undefined
                ? component.opening_depreciation_date
                : stored.opening?.date ?? null,
          }),
    }
  })

  if (target.length === 0) {
    return {
      remaining,
      componentAsset: false,
      deletes: current.map((component) => component.id),
      updates: [],
      inserts: [],
      finalDate,
    }
  }

  if (existing.disposed_at) throw new AssetCorrectionBlockedError('disposed')

  const targetCost = roundOre(target.reduce((sum, component) => sum + Number(component.cost), 0))
  const expectedCost =
    input.acquisition_cost !== undefined
      ? input.acquisition_cost
      : hadComponents
        ? targetCost
        : Number(existing.acquisition_cost)
  const { errors } = validateComponents({
    acquisition_cost: expectedCost,
    acquisition_date: finalDate,
    k3_components: target,
  })
  for (const component of target) {
    if (component.component_id && !storedById.has(component.component_id)) {
      errors.push(`${component.name}: komponenten finns inte bland tillgångens aktiva komponenter.`)
    }
  }
  if (input.salvage_value !== undefined && input.salvage_value !== 0) {
    errors.push('Restvärdet anges per komponent för en tillgång med komponenter.')
  }
  if (errors.length > 0) throw new AssetComponentsInvalidError(errors)

  if (touchesOpening || !hadComponents) {
    const assetOpening = touchesOpening
      ? { amount: input.opening_accumulated_depreciation ?? 0, date: input.opening_depreciation_date ?? null }
      : { amount: Number(existing.opening_accumulated_depreciation ?? 0), date: existing.opening_depreciation_date ?? null }
    target = resolveComponentOpenings(target, assetOpening, finalDate)
  }

  delete remaining.acquisition_cost
  delete remaining.salvage_value
  delete remaining.opening_accumulated_depreciation
  delete remaining.opening_depreciation_date

  const keep = new Set(target.map((component) => component.component_id).filter(Boolean))
  const deletes = current.filter((component) => !keep.has(component.id)).map((component) => component.id)
  const updates: ComponentRowUpdate[] = []
  const inserts: ComponentPatchPlan['inserts'] = []
  target.forEach((component, index) => {
    const stored = component.component_id ? storedById.get(component.component_id) : undefined
    if (!stored) {
      inserts.push({ component, sortOrder: index })
      return
    }
    const desired = componentInsertRow(
      { id: existing.id, company_id: existing.company_id, acquisition_date: finalDate },
      existing.user_id,
      component,
      index,
    )
    const storedColumns: Record<string, unknown> = {
      name: stored.name,
      cost: stored.cost,
      useful_life_months: stored.usefulLifeMonths,
      salvage_value: stored.salvage,
      acquisition_date: stored.acquisitionDate,
      depreciation_start_date: stored.depreciationStartDate === stored.acquisitionDate ? null : stored.depreciationStartDate,
      opening_accumulated_depreciation: stored.opening?.amount ?? 0,
      opening_depreciation_date: stored.opening?.date ?? null,
      sort_order: stored.sortOrder,
    }
    const changes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(storedColumns)) {
      const next = desired[key as keyof typeof desired]
      if (next !== value) changes[key] = next
    }
    if (Object.keys(changes).length > 0) updates.push({ id: stored.id, changes })
  })

  return { remaining, componentAsset: true, deletes, updates, inserts, finalDate }
}

async function executeComponentPatch(
  supabase: SupabaseClient,
  companyId: string,
  asset: Asset,
  plan: ComponentPatchPlan,
  userId: string,
): Promise<void> {
  const refused = (error: { code?: string; message: string } | null) => {
    if (!error) return
    if (error.code === 'PT409' || error.code === '23514') {
      throw new AssetCorrectionBlockedError(asset.disposed_at ? 'disposed' : 'depreciation_posted')
    }
    throw new Error(`Failed to update asset components: ${error.message}`)
  }
  if (plan.deletes.length > 0) {
    const { error } = await supabase
      .from('asset_components')
      .delete()
      .eq('company_id', companyId)
      .eq('asset_id', asset.id)
      .in('id', plan.deletes)
    refused(error)
  }
  for (const update of plan.updates) {
    const { error } = await supabase
      .from('asset_components')
      .update(update.changes)
      .eq('company_id', companyId)
      .eq('asset_id', asset.id)
      .eq('id', update.id)
    refused(error)
  }
  if (plan.inserts.length > 0) {
    const { error } = await supabase
      .from('asset_components')
      .insert(
        plan.inserts.map(({ component, sortOrder }) =>
          componentInsertRow({ id: asset.id, company_id: companyId, acquisition_date: plan.finalDate }, userId, component, sortOrder),
        ),
      )
    refused(error)
  }
}

/**
 * The legitimate BAS window per category, for both the Zod refinement on
 * POST /api/assets and the defense-in-depth check in updateAsset(). Exported
 * so the route validates against this one table: a second hand-maintained
 * copy there is what let the BAS 2026 catalogue update (#2413) miss it.
 *
 * vehicle and computer span the whole maskiner-och-inventarier block
 * (1210-1269) on purpose. BAS 2026 puts a non-production car on 1226 and a
 * non-production computer on 1224, a production one on 1216 / 1214, and the
 * ackumulerade avskrivningar for either on 1219 or 1229, so no narrow
 * per-kind window exists any more. The span also keeps the assets booked on
 * the pre-2026 accounts (1240/1249, 1250/1259, now free accounts) valid on
 * read and update: they keep their stored accounts, and refusing them here
 * would block every edit to an asset created before BAS 2026 (#2414).
 */
export const BAS_RANGES_BY_CATEGORY: Record<
  AssetCategory,
  { asset: [string, string]; accumulated: [string, string]; expense: [string, string] }
> = {
  immaterial:      { asset: ['1010', '1099'], accumulated: ['1010', '1099'], expense: ['7810', '7819'] },
  building:        { asset: ['1100', '1199'], accumulated: ['1100', '1199'], expense: ['7820', '7829'] },
  land:            { asset: ['1130', '1149'], accumulated: ['1100', '1199'], expense: ['7820', '7829'] },
  land_improvement:{ asset: ['1150', '1159'], accumulated: ['1150', '1159'], expense: ['7820', '7829'] },
  machinery:       { asset: ['1210', '1219'], accumulated: ['1210', '1219'], expense: ['7830', '7839'] },
  equipment:       { asset: ['1220', '1229'], accumulated: ['1220', '1229'], expense: ['7830', '7839'] },
  vehicle:         { asset: ['1210', '1269'], accumulated: ['1210', '1269'], expense: ['7830', '7839'] },
  computer:        { asset: ['1210', '1269'], accumulated: ['1210', '1269'], expense: ['7830', '7839'] },
  other_tangible:  { asset: ['1280', '1299'], accumulated: ['1280', '1299'], expense: ['7830', '7839'] },
}

export function inBasRange(account: string, range: [string, string]): boolean {
  return account >= range[0] && account <= range[1]
}

export type AssetDisposalVatTreatment = Exclude<VatTreatment, 'reduced_12' | 'reduced_6'>

export interface DisposeAssetInput {
  disposal_type: AssetDisposalType
  disposed_at: string
  /** Gross consideration, including VAT for a taxable sale. */
  disposed_proceeds: number
  proceeds_account?: string
  fiscal_period_id: string
  vat_treatment?: AssetDisposalVatTreatment
  /** Total original input VAT, whether or not it was fully deducted. */
  jamkning_original_input_vat?: number
  jamkning_original_deduction_percent?: number
  /** Confirms that the transaction qualifies under ML 5:38. */
  business_transfer_confirmed?: boolean
  /** Confirms that the required adjustment document is handled at transfer. */
  adjustment_document_confirmed?: boolean
}

export interface DisposalResult {
  asset: Asset
  /** Disposal entry. Null when no entry was needed (zero-value, fully-
   *  depreciated asset scrapped for nothing). */
  disposal_entry: JournalEntry | null
  gain_or_loss: number
}

export class AssetNotFoundError extends Error {
  readonly code = 'ASSET_NOT_FOUND'
}

export class AssetAlreadyDisposedError extends Error {
  readonly code = 'ASSET_ALREADY_DISPOSED'
}

export class AssetDisposalBlockedError extends Error {
  readonly code = 'ASSET_DISPOSAL_BLOCKED'
  constructor(
    readonly reason: 'later_depreciation_posted' | 'current_depreciation_mismatch' | 'later_value_adjustment',
  ) {
    super(reason)
  }
}

export class AssetJamkningDataRequiredError extends Error {
  readonly code = 'ASSET_JAMKNING_DATA_REQUIRED'
}

export class AssetAdjustmentDocumentRequiredError extends Error {
  readonly code = 'ASSET_ADJUSTMENT_DOCUMENT_REQUIRED'
  constructor() {
    super('ASSET_ADJUSTMENT_DOCUMENT_REQUIRED')
  }
}

export class AssetBusinessTransferConfirmationRequiredError extends Error {
  readonly code = 'ASSET_BUSINESS_TRANSFER_CONFIRMATION_REQUIRED'
  constructor() {
    super('ASSET_BUSINESS_TRANSFER_CONFIRMATION_REQUIRED')
  }
}

interface DisposalScheduleRow {
  /** Needed for a component asset, whose split rows hang off the schedule. */
  id?: string
  fiscal_period_id: string
  planned_depreciation: number | string
  journal_entry_id: string | null
}

interface DisposalFigures {
  currentDepreciation: number
  accumulatedDepreciation: number
  acquisitionCost: number
  /** K3 components: the split of currentDepreciation, sent to the RPC. */
  components?: AssetComponentSplitLine[]
}

/** The depreciation side of a disposal for an asset depreciated as a whole. */
function wholeAssetDisposalFigures(args: {
  asset: Asset
  disposedAt: string
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  periods: Array<Pick<FiscalPeriod, 'id' | 'period_start'> & { period_end?: string }>
  priorPosted: DisposalScheduleRow[]
  priorAccumulated: number
  currentPosted: DisposalScheduleRow | undefined
}): DisposalFigures {
  const { asset, disposedAt, fiscalPeriod, priorAccumulated, currentPosted } = args
  // The posted periods when their dates are loaded, so the charge is the one
  // the depreciation proposal books (a changed life or salvage value applied
  // prospectively, the final period trued up); else the bare total.
  const datedPeriods = args.periods.flatMap((p) => (p.period_end ? [{ ...p, period_end: p.period_end }] : []))
  const requiredCurrent = computeAnnualDepreciation(
    { ...asset, disposed_at: disposedAt },
    fiscalPeriod,
    postedDepreciationHistory(args.priorPosted, datedPeriods) ?? priorAccumulated,
  ).amount

  let currentDepreciation = requiredCurrent
  if (currentPosted) {
    // A year posted before the prospective rule carries the old charge (the
    // bare total: no re-plan, no final true-up). It was right when it was
    // booked, so it is accepted too, and the disposal clears what is on the
    // books: storno and repost would change nothing but the voucher trail.
    const postedCurrent = Number(currentPosted.planned_depreciation)
    const legacyCurrent = computeAnnualDepreciation(
      { ...asset, disposed_at: disposedAt },
      fiscalPeriod,
      priorAccumulated,
    ).amount
    if (Math.abs(postedCurrent - requiredCurrent) > 0.01 && Math.abs(postedCurrent - legacyCurrent) > 0.01) {
      throw new AssetDisposalBlockedError('current_depreciation_mismatch')
    }
    currentDepreciation = 0
  }

  // The opening accumulated depreciation from a previous system sits in the
  // same 12x9 balance (it arrived with the imported ledger), so the disposal
  // clears it together with what Accounted booked.
  const openingAmount = openingDepreciationOf(asset)?.amount ?? 0
  const accumulatedDepreciation = roundOre(
    openingAmount +
      priorAccumulated +
      (currentPosted ? Number(currentPosted.planned_depreciation) : requiredCurrent),
  )
  return { currentDepreciation, accumulatedDepreciation, acquisitionCost: roundOre(Number(asset.acquisition_cost)) }
}

/**
 * The depreciation side of a disposal for an asset the unit engine plans
 * without components (mark, a later start date, a write-down; asset-units.ts):
 * the year's charge to the disposal date from the asset's posted history,
 * after the net write-down dated before the year.
 */
function plainUnitDisposalFigures(args: {
  asset: Asset
  disposedAt: string
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  periods: ReadonlyArray<Pick<FiscalPeriod, 'id' | 'period_start'> & { period_end?: string }>
  postedRows: readonly DisposalScheduleRow[]
  priorAccumulated: number
  currentPosted: DisposalScheduleRow | undefined
}): DisposalFigures {
  const { asset, disposedAt, fiscalPeriod, priorAccumulated, currentPosted } = args
  const datedPeriods = args.periods.flatMap((period) =>
    period.period_end ? [{ id: period.id, period_start: period.period_start, period_end: period.period_end }] : [],
  )
  const postedPeriods = new Set(args.postedRows.map((row) => row.fiscal_period_id))
  const unit = plainAssetUnit(
    { ...asset, disposed_at: disposedAt },
    {
      posted: priorAccumulated,
      writtenDown: writtenDownByKey(asset, { before: fiscalPeriod.period_start }).get(asset.id) ?? 0,
      isComplete: (anchor) =>
        datedPeriods.length === args.periods.length &&
        historyCompleteFrom(anchor, fiscalPeriod.period_start, datedPeriods, postedPeriods),
    },
    fiscalPeriod.period_start,
  )
  const requiredCurrent = computeUnitCharge(unit, fiscalPeriod).amount
  if (currentPosted && Math.abs(Number(currentPosted.planned_depreciation) - requiredCurrent) > 0.01) {
    throw new AssetDisposalBlockedError('current_depreciation_mismatch')
  }
  return {
    currentDepreciation: currentPosted ? 0 : requiredCurrent,
    accumulatedDepreciation: roundOre(
      (unit.opening?.amount ?? 0) +
        priorAccumulated +
        (currentPosted ? Number(currentPosted.planned_depreciation) : requiredCurrent),
    ),
    acquisitionCost: roundOre(Number(asset.acquisition_cost)),
  }
}

/**
 * The depreciation side of a disposal for a K3 component asset: the year's
 * charge to the disposal date per active component from its own history,
 * and everything on the books for those components cleared, each one's
 * opening (a previous system or the K3 split) included. Components replaced
 * earlier left with their own voucher (17.21A) and are not cleared twice.
 */
function componentDisposalFigures(args: {
  asset: Asset
  disposedAt: string
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  periods: ReadonlyArray<Pick<FiscalPeriod, 'id' | 'period_start'> & { period_end?: string }>
  postedRows: readonly DisposalScheduleRow[]
  priorScheduleIds: ReadonlySet<string>
  currentPosted: DisposalScheduleRow | undefined
  splits: readonly ComponentSplitRow[]
}): DisposalFigures {
  const { asset, disposedAt, fiscalPeriod, priorScheduleIds, currentPosted, splits } = args
  const postedBefore = postedByComponent(splits, priorScheduleIds)
  const datedPeriods = args.periods.flatMap((period) =>
    period.period_end ? [{ id: period.id, period_start: period.period_start, period_end: period.period_end }] : [],
  )
  const postedPeriods = new Set(args.postedRows.map((row) => row.fiscal_period_id))
  const required = computeComponentDepreciation({ ...asset, disposed_at: disposedAt }, fiscalPeriod, {
    posted: postedBefore,
    writtenDown: writtenDownByKey(asset, { before: fiscalPeriod.period_start }),
    isComplete: (anchor) =>
      datedPeriods.length === args.periods.length &&
      historyCompleteFrom(anchor, fiscalPeriod.period_start, datedPeriods, postedPeriods),
  })
  const postedThisYear = currentPosted?.id
    ? postedByComponent(splits, new Set([currentPosted.id]))
    : new Map<string, number>()
  if (currentPosted && Math.abs(Number(currentPosted.planned_depreciation) - required.amount) > 0.01) {
    throw new AssetDisposalBlockedError('current_depreciation_mismatch')
  }
  const chargeThisYear = (componentId: string) =>
    currentPosted
      ? postedThisYear.get(componentId) ?? 0
      : required.perComponent.find((charge) => charge.componentId === componentId)?.amount ?? 0

  let accumulatedDepreciation = 0
  let acquisitionCost = 0
  for (const component of activeComponentsOf(asset)) {
    acquisitionCost = roundOre(acquisitionCost + component.cost)
    accumulatedDepreciation = roundOre(
      accumulatedDepreciation +
        (component.opening?.amount ?? 0) +
        (postedBefore.get(component.id) ?? 0) +
        chargeThisYear(component.id),
    )
  }
  const currentDepreciation = currentPosted ? 0 : required.amount
  const split = currentDepreciation > 0.005 ? componentSplitOf(required.perComponent) : undefined
  return {
    currentDepreciation,
    accumulatedDepreciation,
    acquisitionCost,
    ...(split ? { components: split } : {}),
  }
}

export interface DisposalPlan {
  lines: CreateJournalEntryLineInput[]
  currentDepreciation: number
  /** K3 components: the split of currentDepreciation, recorded per component. */
  components?: AssetComponentSplitLine[]
  accumulatedDepreciation: number
  /** Net write-down outstanding (ÅRL 4:5), cleared from 12x8 with the asset. */
  writtenDown: number
  proceedsGross: number
  proceedsVat: number
  vatTreatment: AssetDisposalVatTreatment | null
  gainOrLoss: number
  jamkning: ReturnType<typeof assessJamkning>
}

/**
 * Everything a disposal needs before anything is written: the asset as it
 * stands, the target period, and the fully computed plan (lines, gain/loss,
 * jämkning). `disposeAsset()` posts from this; the v1 dry-run and the MCP
 * staging preview return it unchanged, so what the approver sees is exactly
 * what the commit will book.
 */
export interface AssetDisposalPreview {
  asset: Asset
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  plan: DisposalPlan
}

export function buildAssetDisposalPlan(args: {
  asset: Asset
  /** The account the proceeds landed on: the caller resolves it. */
  proceedsAccount: string
  input: DisposeAssetInput
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  periods: Array<Pick<FiscalPeriod, 'id' | 'period_start'> & { period_end?: string }>
  schedules: DisposalScheduleRow[]
  /** K3 components: the split rows of the asset's posted schedules. */
  componentSplits?: readonly ComponentSplitRow[]
}): DisposalPlan {
  const { asset, input, fiscalPeriod, periods, schedules } = args
  if (input.disposed_at < asset.acquisition_date) {
    throw new Error('Avyttringsdatum kan inte vara före anskaffningsdatum.')
  }

  const periodStartById = new Map(periods.map((period) => [period.id, period.period_start]))
  const posted = schedules.filter((schedule) => schedule.journal_entry_id !== null)
  const laterPosted = posted.some(
    (schedule) => (periodStartById.get(schedule.fiscal_period_id) ?? '') > fiscalPeriod.period_start,
  )
  if (laterPosted) throw new AssetDisposalBlockedError('later_depreciation_posted')

  const priorPosted = posted.filter((schedule) => {
    const start = periodStartById.get(schedule.fiscal_period_id)
    return start !== undefined && start < fiscalPeriod.period_start
  })
  const priorScheduleIds = new Set(priorPosted.map((schedule) => schedule.id ?? ''))
  const currentPosted = posted.find(
    (schedule) => schedule.fiscal_period_id === fiscalPeriod.id,
  )
  // A write-down dated after the disposal was assessed on an asset the
  // company no longer held: reverse it first.
  if (effectiveAdjustments(asset).some((row) => row.adjustment_date > input.disposed_at)) {
    throw new AssetDisposalBlockedError('later_value_adjustment')
  }
  const priorAccumulated = roundOre(
    priorPosted.reduce((sum, schedule) => sum + Number(schedule.planned_depreciation), 0),
  )
  const { currentDepreciation, accumulatedDepreciation, acquisitionCost, components } = hasComponents(asset)
    ? componentDisposalFigures({
        asset,
        disposedAt: input.disposed_at,
        fiscalPeriod,
        periods,
        postedRows: posted,
        priorScheduleIds,
        currentPosted,
        splits: args.componentSplits ?? [],
      })
    : usesUnitEngine(asset)
      ? plainUnitDisposalFigures({
          asset,
          disposedAt: input.disposed_at,
          fiscalPeriod,
          periods,
          postedRows: posted,
          priorAccumulated,
          currentPosted,
        })
      : wholeAssetDisposalFigures({
          asset,
          disposedAt: input.disposed_at,
          fiscalPeriod,
          periods,
          priorPosted,
          priorAccumulated,
          currentPosted,
        })
  // The net write-down per 12x8 it was booked on (ÅRL 4:5): it leaves the
  // books with the asset, like the accumulated depreciation.
  const writtenDownAccounts = [...writtenDownByAccount(asset).entries()].filter(([, amount]) => amount > 0.005)
  const writtenDown = roundOre(writtenDownAccounts.reduce((sum, [, amount]) => sum + amount, 0))
  const proceedsGross = input.disposal_type === 'scrap' ? 0 : roundOre(input.disposed_proceeds)
  const vatTreatment = input.disposal_type === 'sale' ? input.vat_treatment ?? null : null
  if (input.disposal_type === 'sale' && proceedsGross > 0 && !vatTreatment) {
    throw new Error('Momsbehandling krävs vid försäljning.')
  }
  const { vat: proceedsVat, net: proceedsNet } = splitGrossVat(proceedsGross, vatTreatment === 'standard_25' ? 0.25 : 0)
  const netBookValue = roundOre(acquisitionCost - accumulatedDepreciation - writtenDown)
  const gainOrLoss = roundOre(proceedsNet - netBookValue)

  if (input.disposal_type === 'business_transfer' && !input.business_transfer_confirmed) {
    throw new AssetBusinessTransferConfirmationRequiredError()
  }

  const eligibility = assessJamkningEligibility({
    acquisitionDate: asset.acquisition_date,
    disposalDate: input.disposed_at,
    basAssetAccount: asset.bas_asset_account,
    category: asset.category,
  })
  const possibleInvestmentGoodCost = eligibility.totalYears === 10 ? 400_000 : 200_000
  if (
    eligibility.withinAdjustmentPeriod &&
    acquisitionCost >= possibleInvestmentGoodCost &&
    (input.jamkning_original_input_vat === undefined ||
      input.jamkning_original_deduction_percent === undefined)
  ) {
    throw new AssetJamkningDataRequiredError()
  }

  const jamkning = assessJamkning({
    acquisitionDate: asset.acquisition_date,
    disposalDate: input.disposed_at,
    category: asset.category,
    basAssetAccount: asset.bas_asset_account,
    originalInputVat: input.jamkning_original_input_vat ?? 0,
    originalDeductionPercent: input.jamkning_original_deduction_percent ?? 0,
    disposalType: input.disposal_type,
    vatTreatment: vatTreatment ?? undefined,
    netProceeds: proceedsNet,
  })
  if (
    jamkning.direction === 'transferred' &&
    !input.adjustment_document_confirmed
  ) {
    throw new AssetAdjustmentDocumentRequiredError()
  }

  const lines: CreateJournalEntryLineInput[] = []
  if (currentDepreciation > 0.005) {
    lines.push(
      {
        account_number: asset.bas_expense_account,
        debit_amount: currentDepreciation,
        credit_amount: 0,
        line_description: `Avskrivning till avyttringsdag: ${asset.name}`,
      },
      {
        account_number: asset.bas_accumulated_account,
        debit_amount: 0,
        credit_amount: currentDepreciation,
        line_description: `Ackumulerad avskrivning till avyttringsdag: ${asset.name}`,
      },
    )
  }
  if (accumulatedDepreciation > 0.005) {
    lines.push({
      account_number: asset.bas_accumulated_account,
      debit_amount: accumulatedDepreciation,
      credit_amount: 0,
      line_description: `Avyttring: nollställ ackumulerad avskrivning ${asset.name}`,
    })
  }
  for (const [account, amount] of writtenDownAccounts) {
    lines.push({
      account_number: account,
      debit_amount: amount,
      credit_amount: 0,
      line_description: `Avyttring: nollställ ackumulerad nedskrivning ${asset.name}`,
    })
  }
  if (acquisitionCost > 0.005) {
    lines.push({
      account_number: asset.bas_asset_account,
      debit_amount: 0,
      credit_amount: acquisitionCost,
      line_description: `Avyttring: nollställ anskaffningsvärde ${asset.name}`,
    })
  }
  if (proceedsGross > 0.005) {
    lines.push({
      account_number: args.proceedsAccount,
      debit_amount: proceedsGross,
      credit_amount: 0,
      line_description: `Avyttring: erhållet belopp ${asset.name}`,
    })
  }
  if (proceedsVat > 0.005 && vatTreatment) {
    lines.push({
      account_number: outputVatAccountFor(vatTreatment) ?? '2611',
      debit_amount: 0,
      credit_amount: proceedsVat,
      line_description: `Utgående moms vid avyttring av ${asset.name}`,
    })
  }

  const { gain, loss } = disposalAccounts(asset.category)
  if (gainOrLoss > 0.005) {
    lines.push({
      account_number: gain,
      debit_amount: 0,
      credit_amount: gainOrLoss,
      line_description: `Vinst vid avyttring av ${asset.name}`,
    })
  } else if (gainOrLoss < -0.005) {
    lines.push({
      account_number: loss,
      debit_amount: Math.abs(gainOrLoss),
      credit_amount: 0,
      line_description: `Förlust vid avyttring av ${asset.name}`,
    })
  }

  if (jamkning.amount > 0.005 && jamkning.direction === 'decrease') {
    lines.push(
      {
        account_number: '6999',
        debit_amount: jamkning.amount,
        credit_amount: 0,
        line_description: `Negativ justering av ingående moms: ${asset.name}`,
      },
      {
        account_number: '2641',
        debit_amount: 0,
        credit_amount: jamkning.amount,
        line_description: `Justerad ingående moms enligt ML 15 kap: ${asset.name}`,
      },
    )
  } else if (jamkning.amount > 0.005 && jamkning.direction === 'increase') {
    lines.push(
      {
        account_number: '2641',
        debit_amount: jamkning.amount,
        credit_amount: 0,
        line_description: `Justerad ingående moms enligt ML 15 kap: ${asset.name}`,
      },
      {
        account_number: '6999',
        debit_amount: 0,
        credit_amount: jamkning.amount,
        line_description: `Positiv justering av ingående moms: ${asset.name}`,
      },
    )
  }

  return {
    lines,
    currentDepreciation,
    ...(components ? { components } : {}),
    accumulatedDepreciation,
    writtenDown,
    proceedsGross,
    proceedsVat,
    vatTreatment,
    gainOrLoss,
    jamkning,
  }
}

/**
 * Load the disposal context and compute the plan without writing anything.
 * Throws the same typed errors as `disposeAsset()` (not found, already
 * disposed, blocked, jämkning data required) so a preview fails exactly
 * where the real disposal would.
 */
export async function previewAssetDisposal(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  input: DisposeAssetInput,
): Promise<AssetDisposalPreview> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()
  if (asset.disposed_at) throw new AssetAlreadyDisposedError()
  const componentAsset = hasComponents(asset)

  // Paginated past PostgREST's silent 1000-row cap. A truncated period list
  // can drop input.fiscal_period_id (false "Fiscal period not found") and
  // starves the later_depreciation_posted guard of period start dates.
  let periods: Array<Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>>
  let scheduleRows: DisposalScheduleRow[]
  try {
    ;[periods, scheduleRows] = await Promise.all([
      fetchAllRows<Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>>(
        ({ from, to }) =>
          supabase
            .from('fiscal_periods')
            .select('id, period_start, period_end')
            .eq('company_id', companyId)
            .order('period_start', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
      ),
      fetchAllRows<DisposalScheduleRow>(({ from, to }) =>
        supabase
          .from('depreciation_schedules')
          .select('id, fiscal_period_id, planned_depreciation, journal_entry_id')
          .eq('company_id', companyId)
          .eq('asset_id', assetId)
          .order('fiscal_period_id', { ascending: true })
          .range(from, to),
      ),
    ])
  } catch (error) {
    throw new Error(
      `Failed to load disposal context: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const fiscalPeriod = periods.find((period) => period.id === input.fiscal_period_id)
  if (!fiscalPeriod) throw new Error('Fiscal period not found')
  // A component asset's posted history per component (K3 17.4).
  const componentSplits = componentAsset
    ? await loadComponentSplits(
        supabase,
        companyId,
        scheduleRows.filter((row) => row.journal_entry_id !== null && row.id).map((row) => row.id as string),
      )
    : undefined
  const plan = buildAssetDisposalPlan({
    asset,
    proceedsAccount: input.proceeds_account ?? (await resolvePrimaryBankAccount(supabase, companyId, log)),
    input,
    fiscalPeriod,
    periods,
    schedules: scheduleRows,
    ...(componentSplits ? { componentSplits } : {}),
  })
  return { asset, fiscalPeriod, plan }
}

/**
 * The business event of an asset disposal (kind asset.disposed), for the
 * posting port: recorded while POSTING_EVENTS is shadow or strict, never
 * built while it is off. Pure. The asset is the subject; the amount is the
 * gross consideration (0 for a scrapping), money in when there is any, with
 * the utgående moms on it. No category: the asset's own accounts carry what
 * it was, and no party, as the register names no buyer.
 */
export function assetDisposalBusinessEvent(args: {
  asset: Pick<Asset, 'id'>
  input: Pick<DisposeAssetInput, 'disposed_at'>
  plan: Pick<DisposalPlan, 'proceedsGross' | 'proceedsVat' | 'vatTreatment'>
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  const { asset, input, plan, linkBasis } = args
  return {
    kind: 'asset.disposed',
    category: null,
    occurredOn: input.disposed_at,
    subject: { type: 'asset', id: asset.id },
    // The register keeps the consideration in the ledger currency.
    currency: 'SEK',
    amount: plan.proceedsGross,
    amountSek: plan.proceedsGross,
    taxAmounts:
      plan.proceedsVat > 0 ? [{ tax: 'vat', treatment: plan.vatTreatment, amount_sek: plan.proceedsVat }] : [],
    evidence: {
      ...(plan.proceedsGross > 0 ? { direction: 'in' } : {}),
      link_basis: linkBasis.link_basis,
      link_evidence: linkBasis.link_evidence ?? undefined,
    },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('assetDisposal'),
    jurisdiction: 'SE',
  }
}

export async function disposeAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: DisposeAssetInput,
): Promise<DisposalResult> {
  const { asset, plan } = await previewAssetDisposal(supabase, companyId, assetId, input)

  // K3 component breakdown: when the asset was depreciated per component,
  // the voucher notes list the components the disposal takes off the books,
  // so an auditor can trace them. Book value is the active components' cost
  // less everything on the books for them (componentDisposalFigures).
  const activeComponents = activeComponentsOf(asset)
  const componentNotes = activeComponents.length > 0
    ? `K3-komponenter: ${activeComponents
        .map((c) => `${c.name} (${c.cost} kr / ${c.usefulLifeMonths === null ? 'skrivs inte av' : `${c.usefulLifeMonths} mån`})`)
        .join('; ')}`
    : null

  let draft: JournalEntry | null = null
  if (plan.lines.length > 0) {
    // Posting port (step 2): the engine gets the input unchanged; while
    // POSTING_EVENTS is shadow or strict the asset.disposed event is recorded
    // first and linked to the draft, before commit_asset_disposal draws the
    // voucher number.
    draft = await postingPort.draftJournalEntry({
      supabase,
      companyId,
      userId,
      // Built only while the port is on: off, the call is the one it was.
      event: () => assetDisposalBusinessEvent({ asset, input, plan, linkBasis: linkBasisColumns('user_created') }),
      input: {
        fiscal_period_id: input.fiscal_period_id,
        entry_date: input.disposed_at,
        description: `Avyttring av tillgång: ${asset.name}`,
        source_type: 'system',
        lines: plan.lines,
        ...(componentNotes ? { notes: componentNotes } : {}),
      },
    })
  }

  let disposalEntry: JournalEntry | null
  try {
    disposalEntry = await postingPort.commitSqlPosting({
      supabase,
      companyId,
      userId,
      fn: 'commit_asset_disposal',
      args: [
        draft?.id ?? null,
        {
          asset_id: assetId,
          fiscal_period_id: input.fiscal_period_id,
          disposal_type: input.disposal_type,
          disposed_at: input.disposed_at,
          disposed_proceeds: plan.proceedsGross,
          proceeds_vat: plan.proceedsVat,
          vat_treatment: plan.vatTreatment,
          current_depreciation: plan.currentDepreciation,
          jamkning_amount: plan.jamkning.amount,
          jamkning_direction: plan.jamkning.direction,
          jamkning_remaining_years: plan.jamkning.remainingYears ?? null,
          jamkning_total_years: plan.jamkning.totalYears || null,
          jamkning_original_input_vat: input.jamkning_original_input_vat ?? null,
          jamkning_original_deduction_percent:
            input.jamkning_original_deduction_percent ?? null,
          jamkning_new_deduction_percent: plan.jamkning.newDeductionPercent,
          ...(plan.components ? { components: plan.components } : {}),
        },
      ],
    })
  } catch (error) {
    if (draft) {
      await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', draft.id)
        .eq('status', 'draft')
    }
    throw error
  }

  const updated = (await getAsset(supabase, companyId, assetId)) ?? {
    ...asset,
    disposed_at: input.disposed_at,
    disposed_proceeds: plan.proceedsGross,
    disposed_proceeds_vat: plan.proceedsVat,
    disposed_vat_treatment: plan.vatTreatment,
    disposal_type: input.disposal_type,
    disposal_journal_entry_id: disposalEntry?.id ?? null,
    jamkning_amount: plan.jamkning.amount,
    jamkning_direction: plan.jamkning.direction,
  }

  return {
    asset: updated as Asset,
    disposal_entry: disposalEntry,
    gain_or_loss: plan.gainOrLoss,
  }
}

/** Resolve the BAS 26xx output-VAT account for a given VAT treatment.
 *  Returns null for treatments that produce no VAT line. */
function outputVatAccountFor(treatment: VatTreatment): string | null {
  switch (treatment) {
    case 'standard_25':
      return '2611'
    case 'reduced_12':
      return '2621'
    case 'reduced_6':
      return '2631'
    case 'reverse_charge':
    case 'reverse_charge_domestic':
    case 'export':
    case 'exempt':
    case 'outside_scope':
      return null
  }
}

/** Realisationsvinst and -förlust accounts (övrig rörelseintäkt/-kostnad, K3 17.22). */
export function disposalAccounts(category: AssetCategory): { gain: string; loss: string } {
  if (category === 'immaterial') return { gain: '3971', loss: '7971' }
  if (category === 'building' || category === 'land' || category === 'land_improvement') {
    return { gain: '3972', loss: '7972' }
  }
  return { gain: '3973', loss: '7973' }
}

// ── Register-only delete ─────────────────────────────────────────
//
// The anläggningsregister is sidoordnad bokföring (BFL 5 kap. 4 §, BFNAR
// 2013:2 kap. 4). A row becomes räkenskapsinformation the moment it drives a
// voucher: a posted planenlig avskrivning (depreciation_schedules with a
// journal_entry_id) or the avyttring voucher (disposed_at /
// disposal_journal_entry_id). From then on BFL 7 kap. retention applies and
// the only exits are disposal and storno. A row that never reached the books
// (a typo, a Bokio migration test row) is a register entry and nothing else,
// so removing it changes no bokföringspost and may be done outright.
//
// createAsset() posts no acquisition voucher (the purchase is already in the
// ledger), and no document links point at assets, so those two signals do not
// exist here. A hand-posted avskrivningsverifikat is not a blocker either: it
// carries no link to the register row, the ledger is untouched by removing
// the row, and on a shared 12x9 account a ledger scan would refuse every
// migrated company's typo rows. The basis correction guard in updateAsset()
// reads the same predicate (hasPostedDepreciation).

export type AssetDeleteBlockReason = 'disposed' | 'depreciation_posted'

export class AssetDeleteBlockedError extends Error {
  readonly code = 'ASSET_DELETE_BLOCKED'
  constructor(readonly reason: AssetDeleteBlockReason) {
    super(
      reason === 'disposed'
        ? 'Cannot delete a disposed asset: the disposal voucher references it. Reverse the disposal with storno first.'
        : 'Cannot delete an asset with posted depreciation: reverse the depreciation (storno) first, or dispose the asset.',
    )
    this.name = 'AssetDeleteBlockedError'
  }
}

/**
 * The single definition of "reached the books". Pure so every door (list
 * annotation, GET, v1 view, the delete itself) derives `deletable` from the
 * same rule; the async wrapper below feeds it the schedule check.
 */
export function assetDeleteBlockReason(
  asset: Pick<Asset, 'disposed_at' | 'disposal_journal_entry_id' | 'components' | 'value_adjustments'>,
  hasPostedDepreciationRows: boolean,
): AssetDeleteBlockReason | null {
  if (asset.disposed_at || asset.disposal_journal_entry_id) return 'disposed'
  if (hasPostedDepreciationRows) return 'depreciation_posted'
  // A component replacement (K3 17.21A) posted a voucher too, and so did a
  // nedskrivning (reversed or not: its voucher stays in the books).
  if ((asset.components ?? []).some((component) => component.derecognition_journal_entry_id)) {
    return 'depreciation_posted'
  }
  if ((asset.value_adjustments ?? []).length > 0) return 'depreciation_posted'
  return null
}

export async function getAssetDeleteBlock(
  supabase: SupabaseClient,
  companyId: string,
  asset: Asset,
): Promise<AssetDeleteBlockReason | null> {
  const disposed = assetDeleteBlockReason(asset, false)
  if (disposed) return disposed
  return assetDeleteBlockReason(asset, await hasPostedDepreciation(supabase, companyId, asset.id))
}

/**
 * Delete an asset that never reached the books, together with its own
 * unposted depreciation_schedules drafts. Throws AssetNotFoundError (404) when
 * the row is not in this company and AssetDeleteBlockedError (409) when a
 * posted signal exists. Returns the row as it was, for the caller's log line.
 *
 * The rule is decided and the delete performed by delete_never_posted_asset
 * (migration 20260920190200) in ONE transaction, under the asset row lock
 * that commit_asset_depreciation and commit_asset_disposal also take. A
 * posting in flight has therefore either committed (and is seen) or waits and
 * then finds no asset (and posts no voucher): the check-then-delete window
 * issue #2779 described is gone. The RPC is SECURITY INVOKER, so it still
 * runs as the caller: the assets_delete / depreciation_schedules_delete RLS
 * policies and the writer-role trigger apply exactly as before.
 *
 * Behind it sits a BEFORE DELETE guard on posted depreciation_schedules rows,
 * which also fires for the assets FK cascade, so the invariant no longer
 * depends on this function (or any future caller) checking first.
 */
export async function deleteNeverPostedAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
): Promise<Asset> {
  // Read first only for the 404 and the returned row; it decides nothing.
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()

  const { data, error } = await supabase.rpc('delete_never_posted_asset', {
    p_company_id: companyId,
    p_asset_id: assetId,
  })
  if (error) throw new Error(`Failed to delete asset ${assetId}: ${error.message}`)

  switch (data as string | null) {
    case 'deleted':
      return asset
    case 'disposed':
    case 'depreciation_posted':
      throw new AssetDeleteBlockedError(data as AssetDeleteBlockReason)
    case 'not_found':
      // Vanished between the read above and the lock: deleted concurrently.
      throw new AssetNotFoundError()
    default:
      throw new Error(`Failed to delete asset ${assetId}: unexpected outcome ${String(data)}`)
  }
}
