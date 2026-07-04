import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { K3ComponentSchema } from '@/lib/api/schemas'
import { getAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
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

const DEPRECIATION_METHODS: readonly DepreciationMethod[] = [
  'linear',
  'declining_balance_30',
  'declining_balance_20',
  'restvardesavskrivning_25',
] as const

const UpdateAssetSchema = z
  .object({
    name: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    // Acquisition-basis corrections. The service (updateAsset) only permits
    // these while the asset is neither disposed nor depreciated, returning
    // ASSET_CORRECTION_BLOCKED (409) otherwise: they redefine the
    // depreciation basis, so a post-posting change must go through storno.
    category: z
      .enum(ASSET_CATEGORIES as unknown as [AssetCategory, ...AssetCategory[]])
      .optional(),
    acquisition_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    acquisition_cost: z.number().positive().optional(),
    salvage_value: z.number().nonnegative().optional(),
    useful_life_months: z.number().int().positive().optional(),
    depreciation_method: z
      .enum(DEPRECIATION_METHODS as unknown as [DepreciationMethod, ...DepreciationMethod[]])
      .optional(),
    restvarde_target: z.number().nonnegative().nullable().optional(),
    bas_asset_account: z.string().regex(/^\d{4}$/).optional(),
    bas_accumulated_account: z.string().regex(/^\d{4}$/).optional(),
    bas_expense_account: z.string().regex(/^\d{4}$/).optional(),
    // K3 component depreciation. Accepting `null` lets the caller clear an
    // existing breakdown (the engine then falls back to depreciation_method).
    // Per-component validation runs whenever the field is set to a non-null
    // value; the cross-sum check needs acquisition_cost so it's deferred to
    // updateAsset() which can read the existing row.
    k3_components: z.array(K3ComponentSchema).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // Enforce the method/target biconditional when EITHER field is supplied.
    // We can't see the existing row from a zod refinement, so the
    // application-level updateAsset() carries the cross-row check; here we
    // only catch the obviously inconsistent combinations within a single
    // PATCH body.
    const hasMethod = value.depreciation_method !== undefined
    const hasTarget = value.restvarde_target !== undefined
    if (!hasMethod && !hasTarget) return

    const isRestvarde = value.depreciation_method === 'restvardesavskrivning_25'
    const targetIsSet = value.restvarde_target !== null && value.restvarde_target !== undefined

    if (hasMethod && isRestvarde && hasTarget && !targetIsSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restvarde_target'],
        message: 'restvarde_target krävs när avskrivningsmetoden är restvärdeavskrivning (25 %).',
      })
    }
    if (hasMethod && !isRestvarde && hasTarget && targetIsSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restvarde_target'],
        message: 'restvarde_target får bara anges för restvärdeavskrivning (25 %).',
      })
    }
  })

export const GET = withRouteContext(
  'assets.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const asset = await getAsset(supabase, companyId, id)
      if (!asset) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const PATCH = withRouteContext(
  'assets.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateAssetSchema)
    if (!validation.success) return validation.response

    // K3 component depreciation gating + cross-sum check.
    // The Zod refinement cannot see the existing asset's acquisition_cost,
    // so we do both the framework check and the sum validation here at
    // route level before delegating to updateAsset().
    if (validation.data.k3_components !== undefined && validation.data.k3_components !== null) {
      const [{ data: company }, existing] = await Promise.all([
        supabase
          .from('companies')
          .select('accounting_framework')
          .eq('id', companyId)
          .single(),
        getAsset(supabase, companyId, id),
      ])
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
      if (!existing) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      const { errors } = validateComponents({
        acquisition_cost: Number(existing.acquisition_cost),
        k3_components: validation.data.k3_components,
      })
      if (errors.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_K3_COMPONENTS',
              message: errors.join(' '),
            },
          },
          { status: 400 },
        )
      }
    }

    try {
      const asset = await updateAsset(supabase, companyId, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
