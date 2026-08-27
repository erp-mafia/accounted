/**
 * Asset register import: fetch anläggningsregistret from the provider and
 * create matching rows in the local asset register.
 *
 * Fortnox only. The SIE import already carries the bookkeeping VALUES
 * (anskaffningskonton 1xxx and ackumulerade avskrivningar), so this import
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
import { createLogger } from '@/lib/logger'
import type { AssetCategory } from '@/types'
import type { SkipReasons } from '../types'

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
  skipReasons?: SkipReasons & { unsupported?: number }
  errorSample?: string
  /** True when the Fortnox consent lacks the assets scope (or licence): the
   *  step was skipped as a whole rather than failing the migration. */
  scopesMissing?: boolean
}

/**
 * BAS account class → asset category, mirroring the ranges documented on the
 * assets table (migration 20260516120000). The account is the TYPE's
 * anskaffningskonto as configured in Fortnox, which is the most reliable
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
export function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`)
  const to = new Date(`${toIso}T00:00:00Z`)
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) +
    (to.getUTCDate() - from.getUTCDate()) / 30
  return Math.max(1, Math.round(months))
}

/** K2 schablon (5 år) when the source gives no usable depreciation window. */
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

function accountString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return isAccountNumber(text) ? text : null
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
  // defaults inside createAsset. AccountDepreciation is the 1xx9 ackumulerade
  // konto and AccountValueLoss the 78xx cost account in Fortnox's model.
  const accumulated = accountString(type?.AccountDepreciation)
  const expense = accountString(type?.AccountValueLoss)

  const name =
    asset.Description?.trim() ||
    (asset.Number ? `Tillgång ${asset.Number}` : 'Importerad tillgång')

  const noteParts = [
    asset.Number ? `Importerad från Fortnox (tillgång ${asset.Number}).` : 'Importerad från Fortnox.',
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
  return !/sold|såld|scrap|utrangera|delete|raderad|void|annuller|makuler|not[_ ]?active|ej aktiv/i.test(status)
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
  const existing = await fetchAllRows<{ name: string | null; acquisition_date: string | null }>(
    ({ from, to }) =>
      supabase
        .from('assets')
        .select('name, acquisition_date')
        .eq('company_id', companyId)
        .range(from, to),
  )
  const existingKeys = new Set(
    existing.map((row) => `${row.name ?? ''}|${row.acquisition_date ?? ''}`),
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

    const mapped = mapFortnoxAsset(
      asset,
      typeof asset.TypeId === 'number' ? typeById.get(asset.TypeId) : undefined,
    )
    if ('reason' in mapped) {
      skipReasons.unsupported = (skipReasons.unsupported ?? 0) + 1
      skipped++
      continue
    }

    const key = `${mapped.input.name}|${mapped.input.acquisition_date}`
    if (existingKeys.has(key)) {
      skipReasons.duplicate = (skipReasons.duplicate ?? 0) + 1
      skipped++
      continue
    }
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
