import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { K3ComponentSchema } from '@/lib/api/schemas'
import { createAsset, listAssets } from '@/lib/bokslut/assets/asset-service'
import { validateComponents } from '@/lib/bokslut/assets/k3-components'
import type { AssetCategory, DepreciationMethod } from '@/types'

const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'immaterial',
  'building',
  'land_improvement',
  'machinery',
  'equipment',
  'vehicle',
  'computer',
  'other_tangible',
] as const

// All four depreciation methods are now implemented by the engine. The DB
// CHECK constraint mirrors this list (see
// 20260526120100_restvardeavskrivning.sql).
const DEPRECIATION_METHODS: readonly DepreciationMethod[] = [
  'linear',
  'declining_balance_30',
  'declining_balance_20',
  'restvardesavskrivning_25',
] as const

const CreateAssetSchema = z
  .object({
    name: z.string().min(1),
    category: z.enum(ASSET_CATEGORIES as unknown as [AssetCategory, ...AssetCategory[]]),
    acquisition_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    // Positive — a zero-value asset would dodge the depreciation engine and
    // create a no-op row that confuses the balance sheet.
    acquisition_cost: z.number().positive(),
    salvage_value: z.number().nonnegative().optional(),
    useful_life_months: z.number().int().positive(),
    depreciation_method: z
      .enum(DEPRECIATION_METHODS as unknown as [DepreciationMethod, ...DepreciationMethod[]])
      .optional(),
    // Restvärde-target floor for restvärdeavskrivning. Required iff
    // depreciation_method = 'restvardesavskrivning_25'. The DB CHECK enforces
    // the same biconditional; we mirror it in the API for an early, Swedish
    // error message rather than a Postgres check_violation surfacing.
    restvarde_target: z.number().nonnegative().nullable().optional(),
    bas_asset_account: z.string().regex(/^\d{4}$/).optional(),
    bas_accumulated_account: z.string().regex(/^\d{4}$/).optional(),
    bas_expense_account: z.string().regex(/^\d{4}$/).optional(),
    // K3 component depreciation (BFNAR 2012:1 ch.17.4). Only meaningful for
    // companies with accounting_framework='k3' — the route handler rejects
    // K3_REQUIRED_FOR_COMPONENTS for K2 companies. When present, the engine
    // dispatches to per-component linear depreciation instead of the
    // asset-level depreciation_method.
    k3_components: z.array(K3ComponentSchema).nullable().optional(),
    notes: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // Defense-in-depth: when the user overrides BAS accounts, refuse anything
    // outside the legitimate range for the asset category so the chart stays
    // BAS-aligned and INK2R mappings continue to work.
    validateBasOverrides(value, ctx)
    validateRestvardeTarget(value, ctx)
    validateK3Components(value, ctx)
  })

function validateK3Components(
  value: {
    acquisition_cost: number
    k3_components?: { name: string; cost: number; useful_life_months: number; salvage_value?: number }[] | null
  },
  ctx: z.RefinementCtx,
): void {
  if (value.k3_components === undefined || value.k3_components === null) return
  const { errors } = validateComponents({
    acquisition_cost: value.acquisition_cost,
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

function validateRestvardeTarget(
  value: {
    depreciation_method?: DepreciationMethod
    restvarde_target?: number | null
    acquisition_cost?: number
  },
  ctx: z.RefinementCtx,
): void {
  const isRestvarde = value.depreciation_method === 'restvardesavskrivning_25'
  const hasTarget = value.restvarde_target !== undefined && value.restvarde_target !== null
  if (isRestvarde && !hasTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['restvarde_target'],
      message: 'restvarde_target krävs när avskrivningsmetoden är restvärdeavskrivning (25 %).',
    })
  }
  if (!isRestvarde && hasTarget) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['restvarde_target'],
      message: 'restvarde_target får bara anges för restvärdeavskrivning (25 %).',
    })
  }
  if (
    isRestvarde &&
    hasTarget &&
    value.acquisition_cost !== undefined &&
    (value.restvarde_target as number) >= value.acquisition_cost
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['restvarde_target'],
      message:
        'restvarde_target måste vara lägre än anskaffningsvärdet — annars finns inget kvar att skriva av.',
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
  const ranges = BAS_RANGES_BY_CATEGORY[value.category]
  if (value.bas_asset_account && !inRange(value.bas_asset_account, ranges.asset)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_asset_account'],
      message: `Account must be in range ${ranges.asset[0]}–${ranges.asset[1]} for ${value.category}`,
    })
  }
  if (
    value.bas_accumulated_account &&
    !inRange(value.bas_accumulated_account, ranges.accumulated)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_accumulated_account'],
      message: `Account must be in range ${ranges.accumulated[0]}–${ranges.accumulated[1]} for ${value.category}`,
    })
  }
  if (value.bas_expense_account && !inRange(value.bas_expense_account, ranges.expense)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bas_expense_account'],
      message: `Account must be in range ${ranges.expense[0]}–${ranges.expense[1]} for ${value.category}`,
    })
  }
  // Anskaffningskonto and ackumulerade-avskrivningar-konto live in the same
  // class range (e.g. 1010-1099 for immaterial, 1100-1199 for buildings), so
  // a user could pick the same account for both. That would silently net
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

function inRange(account: string, range: [string, string]): boolean {
  return account >= range[0] && account <= range[1]
}

export const GET = withRouteContext('assets.list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const url = new URL(request.url)
  const activeOnly = url.searchParams.get('active') === 'true'
  try {
    const data = await listAssets(supabase, companyId, { activeOnly })
    return NextResponse.json({ data })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})

export const POST = withRouteContext(
  'assets.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, CreateAssetSchema)
    if (!validation.success) return validation.response
    // K3_REQUIRED_FOR_COMPONENTS: K3 component depreciation is only
    // meaningful when the company applies the K3 framework. Reject the
    // write with 422 (Unprocessable Entity) rather than silently dropping
    // the field so the user knows their input was discarded.
    if (validation.data.k3_components !== undefined && validation.data.k3_components !== null) {
      const { data: company } = await supabase
        .from('companies')
        .select('accounting_framework')
        .eq('id', companyId)
        .single()
      if (!company || company.accounting_framework !== 'k3') {
        return NextResponse.json(
          {
            error: {
              code: 'K3_REQUIRED_FOR_COMPONENTS',
              message: 'Komponentuppdelning (k3_components) kräver att företaget tillämpar K3 (BFNAR 2012:1).',
            },
          },
          { status: 422 },
        )
      }
    }
    try {
      const asset = await createAsset(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
