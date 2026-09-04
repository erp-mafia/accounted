/**
 * Asset register import: fetch the provider asset register and
 * create matching rows in the local asset register.
 *
 * Fortnox only. The SIE import already carries the bookkeeping VALUES
 * (the 1xxx acquisition accounts and accumulated depreciation), so this import
 * writes NO journal entries: it recreates the register metadata (per-asset
 * acquisition data, useful life, account triple) that SIE cannot express, so
 * the depreciation engine can keep depreciating after the migration.
 *
 * Depreciation already booked in the source system arrives via SIE and must
 * not be booked again: each imported asset's notes record how far the source
 * system had depreciated it, so the first depreciation proposal after the
 * migration can be reviewed against that.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { FortnoxClient, isFortnoxPermissionError } from '@/lib/providers/fortnox/client'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { createAsset } from '@/lib/bokslut/assets/asset-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { isAccountNumber, isIsoDateShaped } from '@/lib/invariants'
import { countCalendarMonths, dayAfter, firstOfMonth } from '@/lib/bookkeeping/accruals/compute'
import { createLogger } from '@/lib/logger'
import type { AssetCategory } from '@/types'
import type { AssetSkipReasons } from '../types'

const log = createLogger('extensions/arcim-migration/import-assets')

export class FortnoxAssetScopesRequiredError extends Error {
  readonly code = 'PROVIDER_ASSET_SCOPES_REQUIRED'

  constructor() {
    super('Fortnox consent lacks assets scope: asset register not readable')
    this.name = 'FortnoxAssetScopesRequiredError'
  }
}

/** The subset of GET /3/assets fields the import reads. */
export interface FortnoxAsset {
  Number?: string | null
  Description?: string | null
  AcquisitionDate?: string | null
  AcquisitionStart?: string | null
  AcquisitionValue?: number | string | null
  DepreciationFinal?: string | null
  DepreciatedTo?: string | null
  Status?: string | null
  StatusId?: string | null
  TypeId?: number | null
  Type?: string | null
  Notes?: string | null
}

/** The subset of GET /3/assets/types fields the import reads. */
export interface FortnoxAssetType {
  Id?: number | null
  Number?: string | null
  Description?: string | null
  AccountAsset?: number | string | null
  AccountDepreciation?: number | string | null
  AccountValueLoss?: number | string | null
}

export interface AssetsStepResult {
  total: number
  imported: number
  skipped: number
  skipReasons?: AssetSkipReasons
  errorSample?: string
  /** True when the Fortnox consent lacks the assets scope (or licence): the
   *  step was skipped as a whole rather than failing the migration. */
  scopesMissing?: boolean
}

/**
 * BAS account class → asset category, mirroring the ranges documented on the
 * assets table (migration 20260516120000). The account is the TYPE's
 * acquisition account (anskaffningskonto) as configured in Fortnox, which is the most reliable
 * category signal the API exposes.
 */
export function categoryForAssetAccount(account: string | null): AssetCategory | null {
  if (!account || !isAccountNumber(account)) return null
  const n = Number(account)
  if (n >= 1010 && n <= 1099) return 'immaterial'
  if (n >= 1150 && n <= 1159) return 'land_improvement'
  if (n >= 1110 && n <= 1149) return 'building'
  if (n >= 1160 && n <= 1199) return 'building'
  if (n >= 1210 && n <= 1219) return 'machinery'
  if (n >= 1220 && n <= 1239) return 'equipment'
  if (n >= 1240 && n <= 1249) return 'vehicle'
  if (n >= 1250 && n <= 1259) return 'computer'
  if (n >= 1260 && n <= 1299) return 'other_tangible'
  return null
}

function isoDateOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const date = value.slice(0, 10)
  return isIsoDateShaped(date) ? date : null
}

/** Whole months between two ISO dates, rounded to nearest, minimum 1. */
/**
 * Useful life in whole months, from the month the plan starts through the
 * month it ends.
 *
 * On the month grid rather than by counting days. The previous form added
 * (toDay - fromDay) / 30, which turned a plan running 2026-05-28 to
 * 2031-04-30 into 59 months instead of 60 and left every asset acquired
 * mid-month a month short. Measuring to the day AFTER the final date also
 * makes the answer the same whether the source reports the last day of the
 * final month or the first day after it, which Fortnox does not document.
 */
export function monthsBetween(fromIso: string, toIso: string): number {
  return Math.max(1, countCalendarMonths(firstOfMonth(fromIso), firstOfMonth(dayAfter(toIso))) - 1)
}

/** K2 standard useful life (schablon, 5 years) when the source gives no usable depreciation window. */
export const FALLBACK_USEFUL_LIFE_MONTHS = 60

export interface MappedAsset {
  name: string
  category: AssetCategory
  acquisition_date: string
  acquisition_cost: number
  useful_life_months: number
  bas_asset_account?: string
  bas_accumulated_account?: string
  bas_expense_account?: string
  notes: string
}

/**
 * Provenance marker written into the imported asset's notes. It doubles as
 * the re-run identity: the register has no provider-id column, so the marker
 * is what lets a re-run recognize an already-imported Fortnox asset even
 * after it was renamed in either system.
 */
export function fortnoxAssetMarker(number: string): string {
  return `Importerad från Fortnox (tillgång ${number}).`
}

const FORTNOX_ASSET_MARKER_RE = /Importerad från Fortnox \(tillgång ([^)]+)\)\./

/** Extract the Fortnox asset number from an imported asset's notes, if any. */
export function fortnoxNumberFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null
  const match = FORTNOX_ASSET_MARKER_RE.exec(notes)
  return match ? match[1] : null
}

function accountString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return isAccountNumber(text) ? text : null
}

/**
 * Find the asset's type, which is what carries the BAS account triple.
 *
 * By TypeId when the payload has one, and by the `Type` label when it does
 * not. The list endpoint reports the type as text ("1300 - Utveckling") and
 * does not always carry TypeId, so an id-only lookup silently found nothing
 * and every asset fell back to its category default: assets whose ledger sits
 * on 1010 arriving on 1290, and so on for any company whose types are not the
 * standard ones.
 */
export function resolveAssetType(
  asset: FortnoxAsset,
  typeById: Map<number, FortnoxAssetType>,
  types: readonly FortnoxAssetType[],
): FortnoxAssetType | undefined {
  if (typeof asset.TypeId === 'number') {
    const byId = typeById.get(asset.TypeId)
    if (byId) return byId
  }
  const label = asset.Type?.trim()
  if (!label) return undefined

  const normalize = (value: string) => value.trim().toLowerCase()
  const target = normalize(label)

  // Tried in order of how much the match proves. The combined form identifies
  // a type; a number or a description on its own only narrows it, and two
  // types can share either. Take a looser form only when it lands on exactly
  // one type: picking the first of several would put the asset on another
  // type's accounts, which is the failure this function exists to prevent,
  // just harder to notice.
  const candidates = [
    (type: FortnoxAssetType) => {
      const number = type.Number?.trim() ?? ''
      const description = type.Description?.trim() ?? ''
      return number !== '' && description !== '' &&
        normalize(`${number} - ${description}`) === target
    },
    (type: FortnoxAssetType) => {
      const number = type.Number?.trim() ?? ''
      return number !== '' && normalize(number) === target
    },
    (type: FortnoxAssetType) => {
      const description = type.Description?.trim() ?? ''
      return description !== '' && normalize(description) === target
    },
  ]

  for (const matches of candidates) {
    const found = types.filter(matches)
    if (found.length === 1) return found[0]
    if (found.length > 1) return undefined
  }
  return undefined
}

/**
 * Map one Fortnox asset (plus its type's account configuration) to a local
 * CreateAssetInput. Returns null with a reason when the asset cannot be
 * represented (no positive acquisition value, no acquisition date).
 */
export function mapFortnoxAsset(
  asset: FortnoxAsset,
  type: FortnoxAssetType | undefined,
): { input: MappedAsset } | { reason: 'unsupported' } {
  const acquisitionDate =
    isoDateOrNull(asset.AcquisitionDate) ?? isoDateOrNull(asset.AcquisitionStart)
  const acquisitionCost = Number(asset.AcquisitionValue)
  if (!acquisitionDate || !Number.isFinite(acquisitionCost) || acquisitionCost <= 0) {
    return { reason: 'unsupported' }
  }

  const assetAccount = accountString(type?.AccountAsset)
  const category = categoryForAssetAccount(assetAccount) ?? 'other_tangible'

  // Useful life from the source's own depreciation window when it exists.
  const depreciationStart = isoDateOrNull(asset.AcquisitionStart) ?? acquisitionDate
  const depreciationFinal = isoDateOrNull(asset.DepreciationFinal)
  const usefulLifeMonths =
    depreciationFinal && depreciationFinal > depreciationStart
      ? monthsBetween(depreciationStart, depreciationFinal)
      : FALLBACK_USEFUL_LIFE_MONTHS

  // Account triple from the Fortnox type where it is shaped like the BAS
  // account the column expects; anything else falls back to the category
  // defaults inside createAsset. AccountDepreciation is the 1xx9 accumulated-
  // depreciation account and AccountValueLoss the 78xx cost account in
  // Fortnox's model.
  const accumulated = accountString(type?.AccountDepreciation)
  const expense = accountString(type?.AccountValueLoss)

  const name =
    asset.Description?.trim() ||
    (asset.Number ? `Tillgång ${asset.Number}` : 'Importerad tillgång')

  const noteParts = [
    asset.Number ? fortnoxAssetMarker(asset.Number) : 'Importerad från Fortnox.',
  ]
  const depreciatedTo = isoDateOrNull(asset.DepreciatedTo)
  if (depreciatedTo) {
    noteParts.push(
      `Avskriven t.o.m. ${depreciatedTo} i källsystemet; avskrivningar fram till dess är redan bokförda via SIE-importen.`,
    )
  }
  if (asset.Notes?.trim()) noteParts.push(asset.Notes.trim())

  return {
    input: {
      name: name.slice(0, 200),
      category,
      acquisition_date: acquisitionDate,
      acquisition_cost: roundOre(acquisitionCost),
      useful_life_months: usefulLifeMonths,
      bas_asset_account: assetAccount ?? undefined,
      bas_accumulated_account: accumulated?.startsWith('1') ? accumulated : undefined,
      bas_expense_account: expense?.startsWith('78') ? expense : undefined,
      notes: noteParts.join(' '),
    },
  }
}

/**
 * Statuses that belong in the register. Fortnox reports sold/scrapped/deleted
 * assets in the list as well; those are history, not open register rows, and
 * recreating them would immediately mis-state the register against the
 * SIE-imported balances.
 */
export function isImportableStatus(status: string | null | undefined): boolean {
  if (!status) return true
  return !/sold|såld|scrap|utrangera|delete|raderad|void|cancel|annuller|makuler|not[_ ]?active|ej aktiv/i.test(status)
}

const fortnoxClient = new FortnoxClient()

/**
 * Lightweight register stats for the connect-step preview: how many assets
 * the consent can read, and how many of them the migration would import.
 * Returns null when the consent lacks the scope/licence (the preview simply
 * omits the line; the migration reports the same condition properly).
 */
export async function fetchFortnoxAssetPreview(
  accessToken: string,
): Promise<{ total: number; importable: number } | null> {
  try {
    const assets = await fortnoxClient.getPaginated<FortnoxAsset>(
      accessToken,
      '/assets',
      'Assets',
    )
    const importable = assets.filter((asset) =>
      isImportableStatus(asset.Status ?? asset.StatusId),
    ).length
    return { total: assets.length, importable }
  } catch (error) {
    if (isFortnoxPermissionError(error)) return null
    throw error
  }
}

export interface ImportAssetsOptions {
  supabase: SupabaseClient
  companyId: string
  userId: string
  consentId: string
}

/**
 * Fetch the Fortnox asset register and create local asset rows.
 *
 * Throws FortnoxAssetScopesRequiredError when Fortnox refuses the resource
 * for scope/licence reasons; every other per-asset failure is counted and
 * reported, never thrown, so one bad asset cannot discard the rest.
 */
export async function importProviderAssets(
  options: ImportAssetsOptions,
): Promise<AssetsStepResult | null> {
  const { supabase, companyId, userId, consentId } = options

  const resolved = await resolveConsent(companyId, consentId)
  if ((resolved.consent.provider as string) !== 'fortnox') {
    // Only Fortnox exposes an asset register API today; other providers
    // simply have no step.
    return null
  }
  const accessToken = resolved.accessToken

  let assets: FortnoxAsset[]
  let types: FortnoxAssetType[]
  try {
    ;[assets, types] = await Promise.all([
      fortnoxClient.getPaginated<FortnoxAsset>(accessToken, '/assets', 'Assets'),
      fortnoxClient.getPaginated<FortnoxAssetType>(accessToken, '/assets/types', 'Types'),
    ])
  } catch (error) {
    if (isFortnoxPermissionError(error)) {
      throw new FortnoxAssetScopesRequiredError()
    }
    throw error
  }

  const typeById = new Map<number, FortnoxAssetType>()
  for (const type of types) {
    if (typeof type.Id === 'number') typeById.set(type.Id, type)
  }

  // Dedupe against register rows that already exist (re-run of the wizard).
  // Primary identity is the Fortnox asset number recovered from the notes
  // marker, which survives renames in either system; name + acquisition date
  // is the fallback for rows that predate the marker or were edited free.
  const existing = await fetchAllRows<{
    name: string | null
    acquisition_date: string | null
    notes: string | null
  }>(
    ({ from, to }) =>
      supabase
        .from('assets')
        .select('name, acquisition_date, notes')
        .eq('company_id', companyId)
        .range(from, to),
  )
  const existingKeys = new Set(
    existing.map((row) => `${row.name ?? ''}|${row.acquisition_date ?? ''}`),
  )
  const existingFortnoxNumbers = new Set(
    existing
      .map((row) => fortnoxNumberFromNotes(row.notes))
      .filter((n): n is string => n !== null),
  )
  // Pre-existing rows WITHOUT a marker (created by hand, or with edited
  // notes) can still collide with a numbered source asset on name + date:
  // a numbered asset must not re-insert over such a row just because no
  // marker ties them together. Snapshot of the initial state only: newly
  // imported numbered assets are deliberately NOT added here, so two source
  // assets that legitimately share name and date both import.
  const markerlessExistingKeys = new Set(
    existing
      .filter((row) => fortnoxNumberFromNotes(row.notes) === null)
      .map((row) => `${row.name ?? ''}|${row.acquisition_date ?? ''}`),
  )

  let imported = 0
  let skipped = 0
  const skipReasons: AssetsStepResult['skipReasons'] = {}
  let errorSample: string | null = null

  for (const asset of assets) {
    if (!isImportableStatus(asset.Status ?? asset.StatusId)) {
      skipReasons.inactive = (skipReasons.inactive ?? 0) + 1
      skipped++
      continue
    }

    const assetType = resolveAssetType(asset, typeById, types)
    if (!assetType) {
      // Not fatal: the asset still imports on its category default. Counted
      // because those accounts came from a guess about the category rather
      // than from the source, so a register that does not tie to the ledger
      // has a stated reason instead of looking like a deliberate choice.
      skipReasons.typeUnresolved = (skipReasons.typeUnresolved ?? 0) + 1
    }
    const mapped = mapFortnoxAsset(asset, assetType)
    if ('reason' in mapped) {
      skipReasons.unsupported = (skipReasons.unsupported ?? 0) + 1
      skipped++
      continue
    }

    const fortnoxNumber = asset.Number?.trim() || null
    const key = `${mapped.input.name}|${mapped.input.acquisition_date}`
    const alreadyImported = fortnoxNumber
      ? existingFortnoxNumbers.has(fortnoxNumber) || markerlessExistingKeys.has(key)
      : existingKeys.has(key)
    if (alreadyImported) {
      skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
      skipped++
      continue
    }
    if (fortnoxNumber) existingFortnoxNumbers.add(fortnoxNumber)
    existingKeys.add(key)

    try {
      await createAsset(supabase, companyId, userId, mapped.input)
      imported++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('failed to import an asset', error as Error, {
        entityId: asset.Number ?? null,
      })
      errorSample ??= message
      skipReasons.failed = (skipReasons.failed ?? 0) + 1
      skipped++
    }
  }

  return {
    total: assets.length,
    imported,
    skipped,
    skipReasons,
    errorSample: errorSample ?? undefined,
  }
}
