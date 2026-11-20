/**
 * Fixed-asset register (anläggningsregister): the request contracts, the
 * framework gates and the wire shape shared by every door that reads or
 * writes it, i.e. the dashboard routes under app/api/assets, the v1 REST
 * routes under app/api/v1 and the MCP tools. One place, so a rule added for
 * one door cannot silently be missing from another.
 *
 * The register itself is a legal requirement (BFNAR 2013:2 p. 7.3 and the
 * inventarieförteckning that BFL 7 kap. presumes: every anläggningstillgång
 * is tracked per object with acquisition date, cost, useful life and
 * accumulated depreciation), which is why it has to be reachable without the
 * browser.
 */
import { frameworkOnDate } from '@/lib/company/accounting-framework'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { K3ComponentSchema } from '@/lib/api/schemas'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import {
  AssetComponentsInvalidError,
  BAS_RANGES_BY_CATEGORY,
  landRowValid,
  defaultAccountsForCategory,
  inBasRange,
  planComponentPatch,
  type AssetDisposalPreview,
  assetDeleteBlockReason,
} from './asset-service'
import { componentsOf } from './component-depreciation'
import type { ComponentReplacementPreview } from './component-service'
import type { ValueAdjustmentPreview } from './value-adjustment-service'
import { validateComponents } from './k3-components'
import { validateOpeningDepreciation } from './opening-depreciation'
import { findK2ExcludedAccount, k2ExcludedAccountMessages } from './k2-account-guard'
import { chartAwareDefaultAccounts, unusableAssetAccounts } from './asset-chart-accounts'
import type {
  AccountingFramework,
  Asset,
  AssetCategory,
  CreateJournalEntryLineInput,
  EntityType,
  K3Component,
  WritableDepreciationMethod,
} from '@/types'

export const ASSET_CATEGORIES = [
  'immaterial',
  'building',
  'land',
  'land_improvement',
  'machinery',
  'equipment',
  'vehicle',
  'computer',
  'other_tangible',
] as const satisfies readonly AssetCategory[]

export const DEPRECIATION_METHODS = ['linear'] as const satisfies readonly WritableDepreciationMethod[]

export const ASSET_DISPOSAL_TYPES = ['sale', 'scrap', 'business_transfer'] as const

export const ASSET_DISPOSAL_VAT_TREATMENTS = [
  'standard_25',
  'reverse_charge',
  'export',
  'exempt',
] as const

const ISO_DATE = ISO_DATE_RE
const BAS_ACCOUNT = ACCOUNT_NUMBER_RE

function validateK3Components(
  value: {
    acquisition_cost: number
    acquisition_date: string
    k3_components?: K3Component[] | null
  },
  ctx: z.RefinementCtx,
): void {
  if (value.k3_components === undefined || value.k3_components === null) return
  const { errors } = validateComponents({
    acquisition_cost: value.acquisition_cost,
    acquisition_date: value.acquisition_date,
    k3_components: value.k3_components,
  })
  for (const message of errors) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['k3_components'],
      message,
    })
  }
}

function validateBasOverrides(
  value: {
    category: AssetCategory
    bas_asset_account?: string
    bas_accumulated_account?: string
    bas_expense_account?: string
  },
  ctx: z.RefinementCtx,
): void {
  // Defense-in-depth: when the caller overrides BAS accounts, refuse anything
  // outside the legitimate range for the asset category so the chart stays
  // BAS-aligned and INK2R mappings continue to work.
  const ranges = BAS_RANGES_BY_CATEGORY[value.category]
  if (value.bas_asset_account && !inBasRange(value.bas_asset_account, ranges.asset)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_asset_account'],
      message: `Account must be in range ${ranges.asset[0]}-${ranges.asset[1]} for ${value.category}`,
    })
  }
  if (
    value.bas_accumulated_account &&
    !inBasRange(value.bas_accumulated_account, ranges.accumulated)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_accumulated_account'],
      message: `Account must be in range ${ranges.accumulated[0]}-${ranges.accumulated[1]} for ${value.category}`,
    })
  }
  if (value.bas_expense_account && !inBasRange(value.bas_expense_account, ranges.expense)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_expense_account'],
      message: `Account must be in range ${ranges.expense[0]}-${ranges.expense[1]} for ${value.category}`,
    })
  }
  // Anskaffningskonto and ackumulerade-avskrivningar-konto live in the same
  // class range (e.g. 1010-1099 for immaterial, 1100-1199 for buildings), so
  // a caller could pick the same account for both. That would silently net
  // acquisition cost against accumulated depreciation in one bucket and
  // break the INK2R 720x mappings. Force them apart.
  if (
    value.bas_asset_account &&
    value.bas_accumulated_account &&
    value.bas_asset_account === value.bas_accumulated_account
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_accumulated_account'],
      message:
        'Anskaffningskonto och ackumulerade-avskrivningar-konto måste vara olika konton.',
    })
  }
}

const OPENING_AMOUNT_DESCRIPTION =
  'Accumulated depreciation for this asset from the previous asset register, SEK, 0 to acquisition_cost - salvage_value. No voucher or automatic reconciliation: manually reconcile register totals with the imported ledger before depreciation or disposal. Manual ledger postings do not lock opening edits; depreciation posted through Accounted\'s asset register or disposal does. The engine plans the remaining value over the remaining useful life. With k3_components it is the components\' total: split over components that state no opening of their own (by how much of each one\'s life had passed), or equal to their sum.'
const START_DATE_DESCRIPTION =
  'yyyy-MM-dd depreciation starts: the day the asset can be used (K3 17.18), not before acquisition_date. Omitted: from acquisition_date. Locked once depreciation is posted.'

/** Land (mark) is never depreciated: 0 months and nothing a depreciated asset has. */
function validateLifeAndStart(
  value: {
    category?: AssetCategory
    acquisition_date?: string
    useful_life_months?: number
    salvage_value?: number
    opening_accumulated_depreciation?: number
    depreciation_start_date?: string | null
    k3_components?: K3Component[] | null
  },
  ctx: z.RefinementCtx,
): void {
  if (value.category === 'land') {
    if (value.useful_life_months !== undefined && value.useful_life_months !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['useful_life_months'], message: 'Mark skrivs inte av: ange 0 månader.' })
    }
    if (!landRowValid({ ...value, category: 'land' })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message: 'Mark har inget restvärde, inget redan avskrivet belopp, inget startdatum och inga komponenter.',
      })
    }
  } else if (value.category !== undefined && value.useful_life_months === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['useful_life_months'], message: 'Nyttjandeperioden måste vara minst 1 månad (0 gäller bara mark).' })
  }
  if (value.depreciation_start_date && value.acquisition_date && value.depreciation_start_date < value.acquisition_date) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['depreciation_start_date'],
      message: 'Avskrivningen kan inte börja före anskaffningsdatum.',
    })
  }
}

const OPENING_DATE_DESCRIPTION =
  'yyyy-MM-dd the opening accumulated depreciation is stated per. Required when the amount is above 0; not after today, not before acquisition_date.'

export const CreateAssetSchema = z
  .object({
    name: z.string().min(1).describe('Asset name as it appears in the register.'),
    category: z.enum(ASSET_CATEGORIES).describe('BAS category; drives the default account triple.'),
    acquisition_date: z.string().regex(ISO_DATE).describe('yyyy-MM-dd'),
    // Positive: a zero-value asset would dodge the depreciation engine and
    // create a no-op row that confuses the balance sheet.
    acquisition_cost: z.number().positive().describe('Acquisition cost excl. VAT, SEK.'),
    salvage_value: z.number().nonnegative().optional().describe('Restvärde at end of life, SEK. Default 0.'),
    useful_life_months: z.number().int().nonnegative().describe('Nyttjandeperiod in months (60 = 5 years); 0 for land, which is never depreciated.'),
    depreciation_start_date: z.string().regex(ISO_DATE).nullable().optional().describe(START_DATE_DESCRIPTION),
    internally_generated: z.boolean().optional().describe('K3, category immaterial: the company\'s own development expenditure (1010/1019). Needs the aktiveringsmodell (K3 18.7); an aktiebolag moves the same amount to fond för utvecklingsutgifter at year end (ÅRL 4 kap. 2 §).'),
    depreciation_method: z.enum(DEPRECIATION_METHODS).optional().describe('Only linear is writable; default linear.'),
    restvarde_target: z.null().optional(),
    bas_asset_account: z.string().regex(BAS_ACCOUNT).optional().describe('Override the anskaffningskonto (must be in the category range).'),
    bas_accumulated_account: z.string().regex(BAS_ACCOUNT).optional().describe('Override the ackumulerade avskrivningar account.'),
    bas_expense_account: z.string().regex(BAS_ACCOUNT).optional().describe('Override the avskrivningskostnad account.'),
    // K3 component depreciation (BFNAR 2012:1 ch.17.4). Only meaningful for
    // companies with accounting_framework='k3': the gate rejects
    // K3_REQUIRED_FOR_COMPONENTS for K2 companies. When present, the engine
    // dispatches to per-component linear depreciation instead of the
    // asset-level depreciation_method.
    k3_components: z.array(K3ComponentSchema).nullable().optional().describe('K3 component breakdown; K3 companies only. Components must sum to acquisition_cost.'),
    // Migration from another system: depreciation already booked there.
    opening_accumulated_depreciation: z.number().nonnegative().optional().describe(OPENING_AMOUNT_DESCRIPTION),
    opening_depreciation_date: z.string().regex(ISO_DATE).nullable().optional().describe(OPENING_DATE_DESCRIPTION),
    notes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    validateBasOverrides(value, ctx)
    validateK3Components(value, ctx)
    validateLifeAndStart(value, ctx)
    if (value.internally_generated && value.category !== 'immaterial') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['internally_generated'],
        message: 'Eget utvecklingsarbete är en immateriell tillgång.',
      })
    }
    for (const issue of validateOpeningDepreciation(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
    }
  })

export type CreateAssetBody = z.infer<typeof CreateAssetSchema>

export const UpdateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  // Acquisition-basis corrections. The service (updateAsset) only permits
  // these while the asset is neither disposed nor depreciated, returning
  // ASSET_CORRECTION_BLOCKED (409) otherwise: they redefine the
  // depreciation basis, so a post-posting change must go through storno.
  category: z.enum(ASSET_CATEGORIES).optional(),
  acquisition_date: z.string().regex(ISO_DATE).optional(),
  acquisition_cost: z.number().positive().optional(),
  salvage_value: z.number().nonnegative().optional(),
  // 0 only for land (the service sets it for a land asset whatever is sent).
  useful_life_months: z.number().int().nonnegative().optional(),
  depreciation_start_date: z.string().regex(ISO_DATE).nullable().optional().describe(START_DATE_DESCRIPTION),
  depreciation_method: z.enum(DEPRECIATION_METHODS).optional(),
  restvarde_target: z.null().optional(),
  bas_asset_account: z.string().regex(BAS_ACCOUNT).optional(),
  bas_accumulated_account: z.string().regex(BAS_ACCOUNT).optional(),
  bas_expense_account: z.string().regex(BAS_ACCOUNT).optional(),
  // K3 component depreciation. Accepting `null` lets the caller clear an
  // existing breakdown (the engine then falls back to depreciation_method).
  // The cross-sum check needs the asset's acquisition_cost so it runs in
  // checkUpdateAssetGates(), which can read the existing row.
  k3_components: z.array(K3ComponentSchema).nullable().optional(),
  // Opening accumulated depreciation. Cross-field rules (against cost,
  // acquisition date and components) need the stored row, so updateAsset()
  // judges them on the row as it will end up (400 INVALID_OPENING_DEPRECIATION).
  // Part of the depreciation basis: refused once Accounted has posted
  // depreciation for the asset (409 ASSET_CORRECTION_BLOCKED).
  opening_accumulated_depreciation: z.number().nonnegative().optional().describe(OPENING_AMOUNT_DESCRIPTION),
  opening_depreciation_date: z.string().regex(ISO_DATE).nullable().optional().describe(OPENING_DATE_DESCRIPTION),
  own_development: z
    .boolean()
    .optional()
    .describe(
      'K3: mark an asset on 1010-1019 as the company\'s own development (aktiveringsmodellen, 18.7), or unmark it. The fond för utvecklingsutgifter (ÅRL 4 kap. 2 §) follows only marked assets; an unmarked asset on 1010-1019 holds the fund proposal back. Recorded in the audit log.',
    ),
})

export type UpdateAssetBody = z.infer<typeof UpdateAssetSchema>

export const DisposeAssetSchema = z
  .object({
    disposal_type: z.enum(ASSET_DISPOSAL_TYPES).describe('sale, scrap (utrangering) or business_transfer (verksamhetsöverlåtelse, ML 5 kap. 38 §).'),
    disposed_at: z.string().regex(ISO_DATE).describe('yyyy-MM-dd; the disposal voucher date.'),
    disposed_proceeds: z.number().nonnegative().describe('Gross consideration incl. VAT for a taxable sale. 0 for scrap.'),
    proceeds_account: z.string().regex(BAS_ACCOUNT).optional().describe("Account the proceeds landed on (default: the company's primary bank account)."),
    fiscal_period_id: z.string().uuid(),
    vat_treatment: z.enum(ASSET_DISPOSAL_VAT_TREATMENTS).optional().describe('Required for a sale with proceeds; forbidden otherwise.'),
    jamkning_original_input_vat: z.number().nonnegative().optional().describe('Original input VAT at acquisition; enables the ML 15 kap. jämkning assessment together with the deduction percent.'),
    jamkning_original_deduction_percent: z.number().min(0).max(100).optional(),
    business_transfer_confirmed: z.boolean().optional().describe('Confirms the transfer covers a whole business or branch (ML 5 kap. 38 §).'),
    adjustment_document_confirmed: z.boolean().optional().describe('Confirms a justeringshandling is prepared when the jämkning obligation transfers.'),
  })
  .superRefine((value, ctx) => {
    if (value.disposal_type === 'scrap' && value.disposed_proceeds !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disposed_proceeds'],
        message: 'disposed_proceeds måste vara 0 vid utrangering.',
      })
    }
    if (value.disposal_type === 'sale' && value.disposed_proceeds > 0 && !value.vat_treatment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vat_treatment'],
        message: 'vat_treatment krävs vid försäljning.',
      })
    }
    if (value.disposal_type !== 'sale' && value.vat_treatment !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vat_treatment'],
        message: 'vat_treatment får bara anges vid försäljning.',
      })
    }
    const hasVat = value.jamkning_original_input_vat !== undefined
    const hasPercent = value.jamkning_original_deduction_percent !== undefined
    if (hasVat !== hasPercent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasVat
          ? ['jamkning_original_deduction_percent']
          : ['jamkning_original_input_vat'],
        message: 'Ursprungsmoms och ursprunglig avdragsprocent måste anges tillsammans.',
      })
    }
  })

export type DisposeAssetBody = z.infer<typeof DisposeAssetSchema>

// ── Framework gates ──────────────────────────────────────────────

export interface AssetGateFailure {
  code: 'K3_REQUIRED_FOR_COMPONENTS' | 'K2_EXCLUDED_ACCOUNT' | 'INVALID_K3_COMPONENTS' | 'ACCOUNTS_NOT_IN_CHART'
  status: 400 | 422
  message_sv: string
  message_en: string
  details?: Record<string, unknown>
}

const K3_REQUIRED_MESSAGES = {
  message_sv:
    'Komponentuppdelning (k3_components) kräver att företaget tillämpar K3 (BFNAR 2012:1).',
  message_en:
    'Component depreciation (k3_components) requires the company to apply K3 (BFNAR 2012:1).',
} as const

interface CompanyFrameworkRow {
  accounting_framework: AccountingFramework | null
  entity_type: EntityType | null
}

/**
 * The framework of the year the asset was acquired in (frameworkOnDate), and
 * the company's form for the Ej K2 wording. Not companies.accounting_framework:
 * that is the latest year's, and a next year elected K3 would let components
 * and Ej K2 accounts into a K2 year (BFNAR 2016:10 10.2, 10.4).
 */
async function loadCompanyFramework(
  supabase: SupabaseClient,
  companyId: string,
  acquiredOn: string | null | undefined,
): Promise<CompanyFrameworkRow | null> {
  const [{ data }, framework] = await Promise.all([
    supabase.from('companies').select('entity_type').eq('id', companyId).single(),
    frameworkOnDate(supabase, companyId, acquiredOn),
  ])
  const row = data as { entity_type?: EntityType | null } | null
  return { accounting_framework: framework, entity_type: row?.entity_type ?? null }
}

function k2Failure(
  excludedAccount: NonNullable<ReturnType<typeof findK2ExcludedAccount>>,
  entityType: EntityType | null | undefined,
): AssetGateFailure {
  const messages = k2ExcludedAccountMessages(excludedAccount, entityType)
  return {
    code: 'K2_EXCLUDED_ACCOUNT',
    status: 422,
    message_sv: messages.message_sv,
    message_en: messages.message_en,
    details: { account: excludedAccount.account_number },
  }
}

/**
 * Framework gates for a create. One companies fetch serves both checks:
 * 1. K3_REQUIRED_FOR_COMPONENTS: K3 component depreciation is only
 *    meaningful when the company applies K3. Rejected with 422 rather than
 *    silently dropping the field so the caller knows the input was discarded.
 * 2. K2_EXCLUDED_ACCOUNT: accounts flagged k2_excluded ("Ej K2") in the BAS
 *    reference may not carry assets under K2. Checked on the RESOLVED
 *    accounts, mirroring what createAsset() will persist: an explicit
 *    override, or the framework-aware category default (a non-K3 company's
 *    immaterial default is the acquired pair 1090/1099, which is lawful, so
 *    only a deliberate override can trip this).
 */
export async function checkCreateAssetGates(
  supabase: SupabaseClient,
  companyId: string,
  body: CreateAssetBody,
): Promise<AssetGateFailure | null> {
  const company = await loadCompanyFramework(supabase, companyId, body.acquisition_date)
  const isK3Company = company?.accounting_framework === 'k3'
  if (body.k3_components !== undefined && body.k3_components !== null && !isK3Company) {
    return { code: 'K3_REQUIRED_FOR_COMPONENTS', status: 422, ...K3_REQUIRED_MESSAGES }
  }
  if (!isK3Company) {
    const defaults = defaultAccountsForCategory(body.category, company?.accounting_framework)
    const excluded = findK2ExcludedAccount([
      body.bas_asset_account ?? defaults.asset,
      body.bas_accumulated_account ?? defaults.accumulated,
    ])
    if (excluded) return k2Failure(excluded, company?.entity_type)
  }
  // crm#1452: refuse at staging what the create would refuse at commit.
  const accounts = await resolveCreateAccounts(supabase, companyId, body)
  const unusable = await unusableAssetAccounts(supabase, companyId, [
    accounts.asset,
    accounts.accumulated,
    accounts.expense,
  ])
  if (unusable.length > 0) return accountsNotInChartFailure(unusable)
  return null
}

function accountsNotInChartFailure(accountNumbers: string[]): AssetGateFailure {
  const list = accountNumbers.join(', ')
  return {
    code: 'ACCOUNTS_NOT_IN_CHART',
    status: 422,
    message_sv: `Konto ${list} är inaktiverat eller saknas i kontoplanen och kan inte läggas till automatiskt. Aktivera kontot i kontoplanen eller välj ett annat konto.`,
    message_en: `Account ${list} is inactive or missing in the chart of accounts and cannot be added automatically. Activate it in the chart of accounts or choose another account.`,
    details: { account_numbers: accountNumbers },
  }
}

/**
 * Framework gates for an update, judged on the row as it will END UP.
 * Patches that leave category, accounts and components alone skip the gate
 * entirely, so legacy assets already sitting on an excluded account stay
 * editable (name, notes, useful life, ...).
 */
export async function checkUpdateAssetGates(
  supabase: SupabaseClient,
  companyId: string,
  body: UpdateAssetBody,
  existing: Asset,
): Promise<AssetGateFailure | null> {
  const touchesComponents = body.k3_components !== undefined && body.k3_components !== null
  const touchesAccounts =
    body.category !== undefined ||
    body.bas_asset_account !== undefined ||
    body.bas_accumulated_account !== undefined
  if (!touchesComponents && !touchesAccounts) return null

  const company = await loadCompanyFramework(supabase, companyId, body.acquisition_date ?? existing.acquisition_date)
  const isK3Company = company?.accounting_framework === 'k3'

  if (touchesComponents) {
    if (!isK3Company) {
      return { code: 'K3_REQUIRED_FOR_COMPONENTS', status: 422, ...K3_REQUIRED_MESSAGES }
    }
    // The same plan updateAsset() writes from (validated against the asset as
    // it will end up), so a gate and the write cannot disagree.
    try {
      planComponentPatch(existing, body)
    } catch (error) {
      if (error instanceof AssetComponentsInvalidError) {
        const message = error.errors.join(' ')
        return {
          code: 'INVALID_K3_COMPONENTS',
          status: 400,
          message_sv: message,
          message_en: message,
          details: { field: 'k3_components' },
        }
      }
      throw error
    }
  }

  if (touchesAccounts && !isK3Company) {
    // The final accounts mirror updateAsset()'s resolution: a category change
    // without explicit accounts realigns the triple to the new category's
    // framework-aware defaults, so recategorizing to "Immateriell tillgång"
    // lands a K2 company on the acquired pair 1090/1099 and passes. Only a
    // deliberate override onto an Ej K2 account trips the gate.
    const finalCategory = body.category ?? existing.category
    const categoryDefaultsApply =
      body.category !== undefined &&
      body.category !== existing.category &&
      body.bas_asset_account === undefined &&
      body.bas_accumulated_account === undefined &&
      body.bas_expense_account === undefined
    const defaults = defaultAccountsForCategory(finalCategory, company?.accounting_framework)
    const excluded = findK2ExcludedAccount([
      body.bas_asset_account ??
        (categoryDefaultsApply ? defaults.asset : existing.bas_asset_account),
      body.bas_accumulated_account ??
        (categoryDefaultsApply ? defaults.accumulated : existing.bas_accumulated_account),
    ])
    if (excluded) return k2Failure(excluded, company?.entity_type)
  }
  return null
}

// ── Read helpers ─────────────────────────────────────────────────

/**
 * Which of the given assets have at least one depreciation posting. The
 * dashboard uses this to lock the acquisition-basis fields; agents use it to
 * know that a basis correction must go through storno.
 */
export async function loadPostedDepreciationAssetIds(
  supabase: SupabaseClient,
  companyId: string,
  assetIds: string[],
): Promise<Set<string>> {
  const posted = new Set<string>()
  // One row per asset and posted year: paged on id, the ids in slices so a
  // long asset register stays inside the request URL. Past 1,000 rows an
  // asset whose rows came later read as never depreciated.
  for (const ids of chunk(assetIds, 200)) {
    try {
      const rows = await fetchAllRows<{ asset_id: string }>(({ from, to }) =>
        supabase
          .from('depreciation_schedules')
          .select('asset_id')
          .eq('company_id', companyId)
          .in('asset_id', ids)
          .not('journal_entry_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
      )
      for (const row of rows) posted.add(row.asset_id)
    } catch (error) {
      throw new Error(`Failed to load depreciation status: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return posted
}

/**
 * The wire representation every door returns, minus the identifier: the v1
 * REST routes add `id`, the MCP tools add `asset_id` (qualified ids
 * convention). Numeric columns arrive as strings from PostgREST for numeric
 * types, so they are coerced here once.
 */
export function assetView(asset: Asset, hasPostedDepreciation: boolean) {
  return {
    name: asset.name,
    category: asset.category,
    acquisition_date: asset.acquisition_date,
    acquisition_cost: Number(asset.acquisition_cost),
    salvage_value: Number(asset.salvage_value ?? 0),
    useful_life_months: Number(asset.useful_life_months),
    depreciation_start_date: asset.depreciation_start_date ?? null,
    depreciation_method: asset.depreciation_method,
    bas_asset_account: asset.bas_asset_account,
    bas_accumulated_account: asset.bas_accumulated_account,
    bas_expense_account: asset.bas_expense_account,
    k3_components: asset.k3_components ?? null,
    // The component register with each component's state (K3 17.4): the
    // replaced ones too, with the date and voucher that took them off.
    components: Array.isArray(asset.components) ? componentsView(asset) : [],
    opening_accumulated_depreciation: roundOre(Number(asset.opening_accumulated_depreciation ?? 0) || 0),
    opening_depreciation_date: asset.opening_depreciation_date ?? null,
    notes: asset.notes ?? null,
    disposed_at: asset.disposed_at ?? null,
    disposal_type: asset.disposal_type ?? null,
    disposed_proceeds: asset.disposed_proceeds === null || asset.disposed_proceeds === undefined
      ? null
      : Number(asset.disposed_proceeds),
    disposal_journal_entry_id: asset.disposal_journal_entry_id ?? null,
    has_posted_depreciation: hasPostedDepreciation,
    // A register row that never drove a voucher may be deleted outright
    // (DELETE /assets/{id}); one that has must leave through disposal or
    // storno. Same rule as the delete itself: assetDeleteBlockReason().
    deletable: assetDeleteBlockReason(asset, hasPostedDepreciation) === null,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
  }
}

/** The component register of an asset as every door returns it. */
export function componentsView(asset: Asset) {
  const rows = new Map((asset.components ?? []).map((row) => [row.id, row]))
  return componentsOf(asset).map((component) => {
    const row = rows.get(component.id)
    return {
      component_id: component.id,
      name: component.name,
      cost: component.cost,
      useful_life_months: component.usefulLifeMonths,
      salvage_value: component.salvage,
      acquisition_date: component.acquisitionDate,
      depreciation_start_date: component.depreciationStartDate,
      opening_accumulated_depreciation: component.opening?.amount ?? 0,
      opening_depreciation_date: component.opening?.date ?? null,
      replaces_component_id: row?.replaces_component_id ?? null,
      derecognised_at: component.derecognisedAt,
      derecognition_journal_entry_id: row?.derecognition_journal_entry_id ?? null,
    }
  })
}

// ── Component register contracts ─────────────────────────────────

const ComponentFieldsSchema = K3ComponentSchema.omit({ component_id: true })

export const AddComponentSchema = ComponentFieldsSchema.superRefine((value, ctx) => {
  for (const message of validateComponents({ acquisition_cost: value.cost, k3_components: [value] }).errors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cost'], message })
  }
})

export const UpdateComponentSchema = ComponentFieldsSchema.partial()

export const ReplaceComponentSchema = z.object({
  replaced_at: z.string().regex(ISO_DATE).describe('yyyy-MM-dd: the derecognition date, the voucher date.'),
  fiscal_period_id: z.string().uuid().describe('The open fiscal period containing replaced_at.'),
  new_component: ComponentFieldsSchema.nullable().optional().describe('The replacing component (K3 17.5), registered with no voucher: the expenditure is already on the asset account. Omit to derecognise only.'),
})

/** The replacement plan as an approver sees it, shared by every preview door. */
export function replacementPreviewView(preview: ComponentReplacementPreview) {
  const { asset, fiscalPeriod, plan } = preview
  return {
    asset_name: asset.name,
    component_name: plan.componentName,
    fiscal_period_id: fiscalPeriod.id,
    cost: plan.cost,
    depreciation_to_date: plan.depreciationToDate,
    accumulated_depreciation_cleared: plan.accumulatedCleared,
    carrying_amount_loss: plan.carryingAmount,
    new_component: plan.newComponent,
    lines: voucherLinesView(plan.lines),
  }
}

/** A planned voucher's lines as every preview door shows them. */
function voucherLinesView(lines: readonly CreateJournalEntryLineInput[]) {
  return lines.map((line) => ({
    account_number: line.account_number,
    debit: line.debit_amount,
    credit: line.credit_amount,
    description: line.line_description ?? null,
  }))
}

// ── Nedskrivning (ÅRL 4:5, K3 27) ────────────────────────────────

export const ValueAdjustmentSchema = z.object({
  kind: z
    .enum(['impairment', 'impairment_reversal'])
    .describe('impairment (nedskrivning, K3 27.2) or impairment_reversal (återföring, 27.15; never for goodwill).'),
  fiscal_period_id: z
    .string()
    .uuid()
    .describe('The open fiscal year whose balansdag (last day) the recoverable amount is assessed on; the voucher date.'),
  recoverable_amount: z
    .number()
    .nonnegative()
    .describe('Återvinningsvärde on the balansdag, SEK, for the asset as a whole (K3 27.5): the higher of fair value less costs to sell and value in use.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('The indication and how the recoverable amount was assessed (K3 27.3-27.4); kept with the voucher.'),
})

/** The write-down or reversal as an approver sees it, shared by every preview door. */
export function valueAdjustmentPreviewView(preview: ValueAdjustmentPreview) {
  return {
    asset_name: preview.asset.name,
    kind: preview.kind,
    fiscal_period_id: preview.fiscalPeriod.id,
    adjustment_date: preview.adjustmentDate,
    recoverable_amount: preview.recoverableAmount,
    carrying_amount_before: preview.carryingAmountBefore,
    amount: preview.amount,
    carrying_amount_after: preview.carryingAmountAfter,
    components: preview.components ?? null,
    lines: voucherLinesView(preview.lines),
  }
}

/**
 * The disposal plan as the approver sees it: the lines that will be posted,
 * the gain or loss, and the jämkning outcome. Shared by the v1 dry-run and
 * the MCP staging preview so both show exactly what the commit will book.
 */
export function disposalPreviewView(preview: AssetDisposalPreview, input: DisposeAssetBody) {
  const { asset, fiscalPeriod, plan } = preview
  return {
    asset_name: asset.name,
    disposal_type: input.disposal_type,
    disposed_at: input.disposed_at,
    fiscal_period_id: fiscalPeriod.id,
    proceeds_gross: plan.proceedsGross,
    proceeds_vat: plan.proceedsVat,
    vat_treatment: plan.vatTreatment,
    current_depreciation: plan.currentDepreciation,
    accumulated_depreciation: plan.accumulatedDepreciation,
    written_down: plan.writtenDown ?? 0,
    book_value: roundOre(Number(asset.acquisition_cost) - plan.accumulatedDepreciation - (plan.writtenDown ?? 0)),
    gain_or_loss: plan.gainOrLoss,
    jamkning: {
      amount: plan.jamkning.amount,
      direction: plan.jamkning.direction,
    },
    lines: voucherLinesView(plan.lines),
    // Null when nothing needs posting (a fully depreciated asset scrapped for
    // nothing): the register row is still updated.
    posts_journal_entry: plan.lines.length > 0,
  }
}

// ── Response contracts (Zod, for the v1 OpenAPI registry) ────────

export const AssetViewSchema = z.object({
  name: z.string(),
  category: z.enum(ASSET_CATEGORIES),
  acquisition_date: z.string(),
  acquisition_cost: z.number(),
  salvage_value: z.number(),
  useful_life_months: z.number().int().describe('0 for land, which is never depreciated.'),
  depreciation_start_date: z.string().nullable().describe('K3 17.18: the day depreciation starts; null means acquisition_date.'),
  depreciation_method: z.string(),
  bas_asset_account: z.string(),
  bas_accumulated_account: z.string(),
  bas_expense_account: z.string(),
  k3_components: z.array(K3ComponentSchema).nullable().describe('Read-only: the active components (component_id, name, cost, life, salvage).'),
  components: z
    .array(
      z.object({
        component_id: z.string(),
        name: z.string(),
        cost: z.number(),
        useful_life_months: z.number().int().nullable(),
        salvage_value: z.number(),
        acquisition_date: z.string(),
        depreciation_start_date: z.string(),
        opening_accumulated_depreciation: z.number(),
        opening_depreciation_date: z.string().nullable(),
        replaces_component_id: z.string().nullable(),
        derecognised_at: z.string().nullable(),
        derecognition_journal_entry_id: z.string().nullable(),
      }),
    )
    .describe('The K3 component register (17.4), replaced components included with the date and voucher that took them off the books.'),
  opening_accumulated_depreciation: z.number().describe('Ackumulerad avskrivning booked in a previous system before the asset entered Accounted; 0 when none. Never posted by Accounted.'),
  opening_depreciation_date: z.string().nullable(),
  notes: z.string().nullable(),
  disposed_at: z.string().nullable(),
  disposal_type: z.enum(ASSET_DISPOSAL_TYPES).nullable(),
  disposed_proceeds: z.number().nullable(),
  disposal_journal_entry_id: z.string().nullable(),
  has_posted_depreciation: z.boolean().describe('True once any planenlig avskrivning has been posted: acquisition_date, acquisition_cost and category are then locked (ASSET_CORRECTION_BLOCKED) and a correction goes through storno.'),
  deletable: z.boolean().describe('True while the row never reached the books (no posted depreciation, not disposed): DELETE /assets/{id} removes it. False means the row is räkenskapsinformation and leaves only through disposal or storno (409 ASSET_DELETE_BLOCKED).'),
  created_at: z.string(),
  updated_at: z.string(),
})

/**
 * A gate failure as a throwable, for callers whose error path is "throw and
 * let the dispatcher build the envelope" (the MCP tools). The code is a
 * structured-error registry key, so getStructuredError() maps it to the same
 * status and bilingual message the REST doors return.
 */
export class AssetGateError extends Error {
  readonly code: AssetGateFailure['code']
  readonly status: AssetGateFailure['status']
  readonly message_en: string
  readonly details?: Record<string, unknown>
  constructor(failure: AssetGateFailure) {
    super(failure.message_sv)
    this.code = failure.code
    this.status = failure.status
    this.message_en = failure.message_en
    this.details = failure.details
  }
}

/**
 * The account triple a create would persist: explicit overrides, else the
 * framework-aware category default, resolved exactly as createAsset() does.
 * Used by every preview (v1 dry-run, MCP staging) so what the caller sees is
 * what the commit writes.
 */
export async function resolveCreateAccounts(
  supabase: SupabaseClient,
  companyId: string,
  body: Pick<CreateAssetBody, 'category' | 'bas_asset_account' | 'bas_accumulated_account' | 'bas_expense_account'> &
    Partial<Pick<CreateAssetBody, 'acquisition_date'>>,
): Promise<{ asset: string; accumulated: string; expense: string }> {
  const company = await loadCompanyFramework(supabase, companyId, body.acquisition_date)
  const defaults = await chartAwareDefaultAccounts(
    supabase,
    companyId,
    body.category,
    defaultAccountsForCategory(body.category, company?.accounting_framework),
  )
  return {
    asset: body.bas_asset_account ?? defaults.asset,
    accumulated: body.bas_accumulated_account ?? defaults.accumulated,
    expense: body.bas_expense_account ?? defaults.expense,
  }
}
