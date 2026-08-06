import type { SupabaseClient } from '@supabase/supabase-js'
import {
  commitAssetDisposal,
  createDraftEntry,
} from '@/lib/bookkeeping/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { computeAnnualDepreciation } from './depreciation-engine'
import { assessJamkning, assessJamkningEligibility } from './jamkning'
import type {
  AccountingFramework,
  Asset,
  AssetCategory,
  WritableDepreciationMethod,
  AssetDisposalType,
  DepreciationMethod,
  FiscalPeriod,
  K3Component,
  CreateJournalEntryLineInput,
  JournalEntry,
  VatTreatment,
} from '@/types'

export interface AssetAccountTriple {
  asset: string
  accumulated: string
  expense: string
}

/**
 * Default BAS account triples per category, in their K3 form. The user can
 * override at create time; these only kick in when the form doesn't specify
 * accounts. Every account here MUST exist in BAS_REFERENCE
 * (lib/bookkeeping/bas-data/) so the engine's backfillStandardBASAccounts can
 * seed it on a minimal chart: otherwise depreciation throws
 * AccountsNotInChartError (#755). A guard test in asset-service.test.ts
 * enforces that invariant.
 *
 * The intangible entry is framework-dependent: resolve it through
 * defaultAccountsForCategory() rather than reading this map directly, so a K2
 * company never lands on the egenupparbetade pair. See
 * ACQUIRED_IMMATERIAL_ACCOUNTS below.
 *
 * vehicle (1240) and computer (1250) both sit in the maskiner-och-inventarier
 * asset range, so their depreciation maps to 7832 (Avskrivningar på
 * inventarier, verktyg och installationer). 7833/7834 are not in the standard
 * BAS catalog (removed as non-standard in #463).
 */
export const DEFAULT_ACCOUNTS_BY_CATEGORY: Record<AssetCategory, AssetAccountTriple> = {
  immaterial: { asset: '1010', accumulated: '1019', expense: '7810' },
  building: { asset: '1110', accumulated: '1119', expense: '7821' },
  land_improvement: { asset: '1150', accumulated: '1159', expense: '7824' },
  machinery: { asset: '1210', accumulated: '1219', expense: '7831' },
  equipment: { asset: '1220', accumulated: '1229', expense: '7832' },
  vehicle: { asset: '1240', accumulated: '1249', expense: '7832' },
  computer: { asset: '1250', accumulated: '1259', expense: '7832' },
  other_tangible: { asset: '1290', accumulated: '1299', expense: '7839' },
}

/**
 * The acquired-intangible pair, i.e. the K2 default for the immaterial
 * category.
 *
 * K2 forbids capitalizing EGENUPPARBETADE immateriella tillgångar, which is
 * exactly what 1010/1019 (Utvecklingsutgifter) carry: the BAS chart flags them
 * k2_excluded ("Ej K2"). A PURCHASED intangible (a software licence, a
 * trademark, a patent) is perfectly lawful under K2 and belongs on 1090
 * Övriga immateriella anläggningstillgångar / 1099 Ackumulerade avskrivningar
 * på övriga immateriella anläggningstillgångar. Both carry k2_excluded: false
 * and both sit inside the 1010-1099 range the immaterial category permits, so
 * the Zod range refinement and the K2 gate accept them.
 *
 * Source: .claude/skills/swedish-year-end-closing/references/k2-vs-k3.md:24,
 * "K2: All development costs must be expensed immediately. Only acquired
 * intangibles may be recognized."
 */
const ACQUIRED_IMMATERIAL_ACCOUNTS = { asset: '1090', accumulated: '1099' } as const

/**
 * Category defaults for a given accounting framework. Only the intangible
 * category depends on the framework; everything else is identical either way.
 * Anything other than 'k3' (including a null column) counts as K2, mirroring
 * how the rest of the codebase reads the flag.
 *
 * The expense account is framework-independent: 7810 (Avskrivningar på
 * immateriella anläggningstillgångar) covers both pairs.
 */
export function defaultAccountsForCategory(
  category: AssetCategory,
  framework: AccountingFramework | null | undefined,
): AssetAccountTriple {
  const defaults = DEFAULT_ACCOUNTS_BY_CATEGORY[category]
  if (category !== 'immaterial' || framework === 'k3') return defaults
  return { ...defaults, ...ACQUIRED_IMMATERIAL_ACCOUNTS }
}

/**
 * The same defaults, resolved against the company's stored framework. Doing
 * the lookup here rather than at the API layer means every write path (create
 * dialog, edit dialog, MCP, a future importer) gets the lawful default without
 * having to know the rule: the edit dialog in particular sends only the fields
 * it changed and has no account inputs at all.
 *
 * The companies read only happens for the intangible category, the one case
 * whose answer depends on it. A failed read throws instead of guessing a
 * framework: silently picking an account off an unchecked read is what put
 * purchased intangibles on 1010 in the first place.
 */
async function resolveDefaultAccounts(
  supabase: SupabaseClient,
  companyId: string,
  category: AssetCategory,
): Promise<AssetAccountTriple> {
  if (category !== 'immaterial') return DEFAULT_ACCOUNTS_BY_CATEGORY[category]
  const { data, error } = await supabase
    .from('companies')
    .select('accounting_framework')
    .eq('id', companyId)
    .single()
  if (error) {
    throw new Error(
      `Failed to load accounting framework for company ${companyId}: ${error.message}`,
    )
  }
  const framework = (data as { accounting_framework?: AccountingFramework | null } | null)
    ?.accounting_framework
  return defaultAccountsForCategory(category, framework)
}

export interface CreateAssetInput {
  name: string
  category: AssetCategory
  acquisition_date: string
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
  notes?: string
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
  const defaults = await resolveDefaultAccounts(supabase, companyId, input.category)
  const row = {
    user_id: userId,
    company_id: companyId,
    name: input.name,
    category: input.category,
    acquisition_date: input.acquisition_date,
    acquisition_cost: input.acquisition_cost,
    salvage_value: input.salvage_value ?? 0,
    useful_life_months: input.useful_life_months,
    depreciation_method: 'linear' as const,
    restvarde_target: null,
    bas_asset_account: input.bas_asset_account ?? defaults.asset,
    bas_accumulated_account: input.bas_accumulated_account ?? defaults.accumulated,
    bas_expense_account: input.bas_expense_account ?? defaults.expense,
    // K3 components are persisted as JSONB. The route handler enforces the
    // accounting_framework='k3' gate; here we only pass the value through
    // (null when omitted, so K2 assets stay clean).
    k3_components: input.k3_components ?? null,
    notes: input.notes ?? null,
  }

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

export async function listAssets(
  supabase: SupabaseClient,
  companyId: string,
  options: { activeOnly?: boolean } = {},
): Promise<Asset[]> {
  // Paginated past PostgREST's silent 1000-row cap — the depreciation engine
  // iterates this list, so truncation would silently skip assets at year-end.
  // Secondary order on id gives the stable total order .range() paging
  // requires; acquisition_date alone is not unique.
  try {
    return await fetchAllRows<Asset>(({ from, to }) => {
      let query = supabase
        .from('assets')
        .select('*')
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
    .select('*')
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
}

/**
 * True when at least one depreciation_schedules row for this asset is linked
 * to a posted journal entry. A `head` count keeps it cheap: we only need
 * existence, not the rows. Used to gate acquisition-basis corrections.
 */
async function hasPostedDepreciation(
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
  return (count ?? 0) > 0
}

/**
 * Catch depreciation that was posted by hand (a manual avskrivningsverifikat),
 * which leaves no depreciation_schedules row and so slips past
 * hasPostedDepreciation. We look at the ledger instead: any posted CREDIT to
 * the asset's ackumulerade-avskrivningar account (12x9) is depreciation.
 *
 * The wrinkle is shared accounts: siblings in the same category default to
 * the same 12x9, so a sibling's *engine* avskrivning would otherwise look like
 * depreciation of this asset. We exclude entries that depreciation_schedules
 * attributes to a *different* asset, so engine siblings don't cause a false
 * block. What remains is depreciation tied to this asset (engine or manual)
 * plus the rare case of a manual sibling entry on a shared account, there we
 * err toward blocking, which is the safe direction for a basis correction.
 */
async function hasManualDepreciationPosted(
  supabase: SupabaseClient,
  companyId: string,
  asset: Asset,
): Promise<boolean> {
  // Engine-posted depreciation entries that belong to OTHER assets: these are
  // safely attributable and must not block a correction of this asset.
  const { data: otherSched, error: schedError } = await supabase
    .from('depreciation_schedules')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .neq('asset_id', asset.id)
    .not('journal_entry_id', 'is', null)
  if (schedError) {
    throw new Error(
      `Failed to load sibling depreciation entries for asset ${asset.id}: ${schedError.message}`,
    )
  }
  const siblingEngineEntries = new Set(
    ((otherSched ?? []) as { journal_entry_id: string | null }[])
      .map((r) => r.journal_entry_id)
      .filter((id): id is string => id !== null),
  )

  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts): posted
  // entries for the company first, then their lines on the accumulated
  // account with a credit.
  let lines: { journal_entry_id: string }[]
  try {
    lines = await fetchEntryLines<{ journal_entry_id: string }>({
      supabase,
      lineColumns: 'journal_entry_id',
      filterEntries: (q: EntryLinesQuery) =>
        q.eq('company_id', companyId).eq('status', 'posted'),
      filterLines: (q: EntryLinesQuery) =>
        q.eq('account_number', asset.bas_accumulated_account).gt('credit_amount', 0),
      attachEntriesAs: null,
    })
  } catch (err) {
    throw new Error(
      `Failed to scan ledger depreciation for asset ${asset.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return lines.some((line) => !siblingEngineEntries.has(line.journal_entry_id))
}

export async function updateAsset(
  supabase: SupabaseClient,
  companyId: string,
  assetId: string,
  inputParam: UpdateAssetInput,
): Promise<Asset> {
  // Copy so category-driven account defaults do not mutate the caller's object.
  let input: UpdateAssetInput = { ...inputParam }

  // Almost every meaningful patch needs the current row (range checks, the
  // method/target biconditional, the correction guard). Load it once.
  const needsExisting =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined ||
    input.depreciation_method !== undefined ||
    input.bas_asset_account !== undefined ||
    input.bas_accumulated_account !== undefined ||
    input.bas_expense_account !== undefined
  let existing: Asset | null = null
  if (needsExisting) {
    existing = await getAsset(supabase, companyId, assetId)
    if (!existing) throw new Error('Asset not found')
  }

  // ── Correction guard ──────────────────────────────────────────────
  // acquisition_date / acquisition_cost / category redefine the depreciation
  // basis. Correcting a fresh data-entry mistake is safe, but once the basis
  // has driven postings (disposal voucher or booked avskrivningar) the edit
  // would silently desync those vouchers from the register. Force those cases
  // through reverse/storno instead.
  const isCorrection =
    input.category !== undefined ||
    input.acquisition_date !== undefined ||
    input.acquisition_cost !== undefined
  if (isCorrection && existing) {
    if (existing.disposed_at) {
      throw new AssetCorrectionBlockedError('disposed')
    }
    // Engine-driven (depreciation_schedules) OR hand-posted (ledger): either
    // means the basis has driven postings and a correction must go via storno.
    if (
      (await hasPostedDepreciation(supabase, companyId, assetId)) ||
      (await hasManualDepreciationPosted(supabase, companyId, existing))
    ) {
      throw new AssetCorrectionBlockedError('depreciation_posted')
    }
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
    const defaults = await resolveDefaultAccounts(supabase, companyId, input.category)
    input = {
      ...input,
      bas_asset_account: defaults.asset,
      bas_accumulated_account: defaults.accumulated,
      bas_expense_account: defaults.expense,
    }
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

  const { data, error } = await supabase
    .from('assets')
    .update(input)
    .eq('id', assetId)
    .eq('company_id', companyId)
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to update asset: ${error?.message ?? 'unknown'}`)
  }
  return data as Asset
}

const BAS_RANGES_BY_CATEGORY: Record<
  AssetCategory,
  { asset: [string, string]; accumulated: [string, string]; expense: [string, string] }
> = {
  immaterial:      { asset: ['1010', '1099'], accumulated: ['1010', '1099'], expense: ['7810', '7819'] },
  building:        { asset: ['1100', '1199'], accumulated: ['1100', '1199'], expense: ['7820', '7829'] },
  land_improvement:{ asset: ['1150', '1159'], accumulated: ['1150', '1159'], expense: ['7820', '7829'] },
  machinery:       { asset: ['1210', '1219'], accumulated: ['1210', '1219'], expense: ['7830', '7839'] },
  equipment:       { asset: ['1220', '1229'], accumulated: ['1220', '1229'], expense: ['7830', '7839'] },
  vehicle:         { asset: ['1240', '1249'], accumulated: ['1240', '1249'], expense: ['7830', '7839'] },
  computer:        { asset: ['1250', '1259'], accumulated: ['1250', '1259'], expense: ['7830', '7839'] },
  other_tangible:  { asset: ['1280', '1299'], accumulated: ['1280', '1299'], expense: ['7830', '7839'] },
}

function inBasRange(account: string, range: [string, string]): boolean {
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
  constructor(readonly reason: 'later_depreciation_posted' | 'current_depreciation_mismatch') {
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
  fiscal_period_id: string
  planned_depreciation: number | string
  journal_entry_id: string | null
}

interface DisposalPlan {
  lines: CreateJournalEntryLineInput[]
  currentDepreciation: number
  accumulatedDepreciation: number
  proceedsGross: number
  proceedsVat: number
  vatTreatment: AssetDisposalVatTreatment | null
  gainOrLoss: number
  jamkning: ReturnType<typeof assessJamkning>
}

export function buildAssetDisposalPlan(args: {
  asset: Asset
  input: DisposeAssetInput
  fiscalPeriod: Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end'>
  periods: Array<Pick<FiscalPeriod, 'id' | 'period_start'>>
  schedules: DisposalScheduleRow[]
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

  const currentPosted = posted.find(
    (schedule) => schedule.fiscal_period_id === fiscalPeriod.id,
  )
  const priorAccumulated = round2(
    posted
      .filter((schedule) => {
        const start = periodStartById.get(schedule.fiscal_period_id)
        return start !== undefined && start < fiscalPeriod.period_start
      })
      .reduce((sum, schedule) => sum + Number(schedule.planned_depreciation), 0),
  )
  const requiredCurrent = computeAnnualDepreciation(
    { ...asset, disposed_at: input.disposed_at },
    fiscalPeriod,
    priorAccumulated,
  ).amount

  let currentDepreciation = requiredCurrent
  if (currentPosted) {
    if (Math.abs(Number(currentPosted.planned_depreciation) - requiredCurrent) > 0.01) {
      throw new AssetDisposalBlockedError('current_depreciation_mismatch')
    }
    currentDepreciation = 0
  }

  const accumulatedDepreciation = round2(
    priorAccumulated + (currentPosted ? Number(currentPosted.planned_depreciation) : requiredCurrent),
  )
  const acquisitionCost = round2(Number(asset.acquisition_cost))
  const proceedsGross = input.disposal_type === 'scrap' ? 0 : round2(input.disposed_proceeds)
  const vatTreatment = input.disposal_type === 'sale' ? input.vat_treatment ?? null : null
  if (input.disposal_type === 'sale' && proceedsGross > 0 && !vatTreatment) {
    throw new Error('Momsbehandling krävs vid försäljning.')
  }
  const proceedsVat = round2(
    vatTreatment === 'standard_25' ? proceedsGross * (0.25 / 1.25) : 0,
  )
  const proceedsNet = round2(proceedsGross - proceedsVat)
  const netBookValue = round2(acquisitionCost - accumulatedDepreciation)
  const gainOrLoss = round2(proceedsNet - netBookValue)

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
      account_number: input.proceeds_account ?? '1930',
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
    accumulatedDepreciation,
    proceedsGross,
    proceedsVat,
    vatTreatment,
    gainOrLoss,
    jamkning,
  }
}

export async function disposeAsset(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  assetId: string,
  input: DisposeAssetInput,
): Promise<DisposalResult> {
  const asset = await getAsset(supabase, companyId, assetId)
  if (!asset) throw new AssetNotFoundError()
  if (asset.disposed_at) throw new AssetAlreadyDisposedError()

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
          .select('fiscal_period_id, planned_depreciation, journal_entry_id')
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
  const plan = buildAssetDisposalPlan({
    asset,
    input,
    fiscalPeriod,
    periods,
    schedules: scheduleRows,
  })

  // K3 component breakdown: when the asset was depreciated per-component,
  // we surface the component list in the journal entry notes so auditors
  // can trace which underlying components contributed to the disposal.
  // Gain/loss math is unchanged: total book value is still
  // acquisition_cost − accumulated_depreciation regardless of structure,
  // because component depreciations sum into the same accumulated account.
  const hasComponents =
    Array.isArray(asset.k3_components) && asset.k3_components.length > 0
  const componentNotes = hasComponents
    ? `K3-komponenter: ${(asset.k3_components ?? [])
        .map((c) => `${c.name} (${round2(Number(c.cost))} kr / ${c.useful_life_months} mån)`)
        .join('; ')}`
    : null

  let draft: JournalEntry | null = null
  if (plan.lines.length > 0) {
    draft = await createDraftEntry(supabase, companyId, userId, {
      fiscal_period_id: input.fiscal_period_id,
      entry_date: input.disposed_at,
      description: `Avyttring av tillgång: ${asset.name}`,
      source_type: 'system',
      lines: plan.lines,
      ...(componentNotes ? { notes: componentNotes } : {}),
    })
  }

  let disposalEntry: JournalEntry | null
  try {
    disposalEntry = await commitAssetDisposal(
      supabase,
      companyId,
      userId,
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
      },
    )
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
    case 'export':
    case 'exempt':
      return null
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function disposalAccounts(category: AssetCategory): { gain: string; loss: string } {
  if (category === 'immaterial') return { gain: '3971', loss: '7971' }
  if (category === 'building' || category === 'land_improvement') {
    return { gain: '3972', loss: '7972' }
  }
  return { gain: '3973', loss: '7973' }
}

/**
 * Sum prior depreciation booked against an asset's 78xx avskrivningskonto
 * up to and including `asOfDate`. Reads from journal_entry_lines so manually-
 * posted avskrivningsverifikationer (i.e. not driven by depreciation_schedules)
 * are also counted: the declining-balance engine needs the most accurate
 * net book value to compute the next period's charge.
 *
 * Only counts posted entries against the asset's `bas_expense_account`
 * (the 78xx avskrivningskonto), and only debits (since avskrivning = debit
 * 78xx / credit 12x9). Returns 0 if the asset has never been depreciated.
 *
 * Why we look at the expense account rather than the accumulated account:
 * the expense account is asset-specific by convention (7831 for machinery,
 * 7832 for equipment, etc.) so we can scope per-asset accurately, whereas
 * the accumulated account (12x9) may aggregate across assets in the same
 * category. Limitation: when multiple assets share the same bas_expense_account
 * we cannot disambiguate at the journal line level. The depreciation_schedules
 * sum (see `sumPostedDepreciation`) is the safer fallback in that case.
 * Callers that need exact per-asset accuracy should prefer the schedules sum.
 */
export async function getAccumulatedDepreciationAsOf(
  supabase: SupabaseClient,
  assetId: string,
  asOfDate: string,
): Promise<number> {
  // 1. Resolve the asset and its expense account first so we can target the
  //    correct 78xx code.
  const { data: asset, error: assetError } = await supabase
    .from('assets')
    .select('bas_expense_account, company_id')
    .eq('id', assetId)
    .maybeSingle()

  if (assetError) {
    throw new Error(`Failed to load asset for accumulated depreciation: ${assetError.message}`)
  }
  if (!asset) return 0

  // Two-step entry-lines fetch (see lib/bookkeeping/entry-lines.ts).
  type Row = { debit_amount: number | string | null; credit_amount: number | string | null }
  let data: Row[]
  try {
    data = await fetchEntryLines<Row>({
      supabase,
      lineColumns: 'debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) =>
        q
          .eq('company_id', asset.company_id)
          .eq('status', 'posted')
          .lte('entry_date', asOfDate),
      filterLines: (q: EntryLinesQuery) =>
        q.eq('account_number', asset.bas_expense_account),
      attachEntriesAs: null,
    })
  } catch (err) {
    throw new Error(
      `Failed to sum accumulated depreciation for asset ${assetId}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return data.reduce((sum, row) => {
    // Expense account: normal balance is debit. Net = debit − credit so
    // any storno (reversal) is netted out.
    return sum + ((Number(row.debit_amount) || 0) - (Number(row.credit_amount) || 0))
  }, 0)
}
