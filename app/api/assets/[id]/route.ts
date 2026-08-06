import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { K3ComponentSchema } from '@/lib/api/schemas'
import {
  getAsset,
  updateAsset,
  defaultAccountsForCategory,
} from '@/lib/bokslut/assets/asset-service'
import { validateComponents } from '@/lib/bokslut/assets/k3-components'
import {
  findK2ExcludedAccount,
  k2ExcludedAccountMessages,
} from '@/lib/bokslut/assets/k2-account-guard'
import type { AssetCategory, WritableDepreciationMethod } from '@/types'

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

const DEPRECIATION_METHODS: readonly WritableDepreciationMethod[] = [
  'linear',
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
      .enum(DEPRECIATION_METHODS as unknown as [
        WritableDepreciationMethod,
        ...WritableDepreciationMethod[],
      ])
      .optional(),
    restvarde_target: z.null().optional(),
    bas_asset_account: z.string().regex(/^\d{4}$/).optional(),
    bas_accumulated_account: z.string().regex(/^\d{4}$/).optional(),
    bas_expense_account: z.string().regex(/^\d{4}$/).optional(),
    // K3 component depreciation. Accepting `null` lets the caller clear an
    // existing breakdown (the engine then falls back to depreciation_method).
    // Per-component validation runs whenever the field is set to a non-null
    // value; the cross-sum check needs the asset's acquisition_cost so it runs
    // in the PATCH handler below, which can read the existing row.
    k3_components: z.array(K3ComponentSchema).nullable().optional(),
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
      // Validate against the cost that will be in effect after this PATCH —
      // a body that changes acquisition_cost and k3_components together must
      // sum to the NEW cost, not the stored one.
      const { errors } = validateComponents({
        acquisition_cost: validation.data.acquisition_cost ?? Number(existing.acquisition_cost),
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

    // K2_EXCLUDED_ACCOUNT gate: when the patch touches the category or the
    // asset/accumulated accounts, the asset must not END UP on an account the
    // BAS reference flags as k2_excluded ("Ej K2") unless the company applies
    // K3. The guard supplies the message, citing BFNAR 2016:10 punkt 10.4
    // only for the egenupparbetade-immateriella group and staying generic for
    // the other Ej K2 accounts (uppskjuten skatt, verkligt värde, ...), which
    // this route can reach: UpdateAssetSchema has no BAS range refinement, so
    // an explicit override outside the category range lands here first.
    // The final accounts mirror updateAsset()'s resolution: a category
    // change without explicit accounts realigns the triple to the new
    // category's framework-aware defaults, so recategorizing to "Immateriell
    // tillgång" lands a K2 company on the acquired pair 1090/1099 and passes.
    // Only a deliberate override onto an Ej K2 account trips the gate.
    // Patches that leave category and accounts alone skip the gate entirely,
    // so legacy assets already sitting on an excluded account stay editable
    // (name, notes, useful life, ...).
    const touchesAccounts =
      validation.data.category !== undefined ||
      validation.data.bas_asset_account !== undefined ||
      validation.data.bas_accumulated_account !== undefined
    if (touchesAccounts) {
      const [{ data: company }, existing] = await Promise.all([
        supabase
          .from('companies')
          // entity_type rides along on the same fetch: the rejection wording
          // must not cite BFNAR 2016:10 at an enskild firma, which prepares no
          // årsredovisning under K2. See lib/bokslut/assets/k2-account-guard.ts.
          .select('accounting_framework, entity_type')
          .eq('id', companyId)
          .single(),
        getAsset(supabase, companyId, id),
      ])
      if (!company || company.accounting_framework !== 'k3') {
        if (!existing) {
          return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
        }
        const finalCategory = validation.data.category ?? existing.category
        const categoryDefaultsApply =
          validation.data.category !== undefined &&
          validation.data.category !== existing.category &&
          validation.data.bas_asset_account === undefined &&
          validation.data.bas_accumulated_account === undefined &&
          validation.data.bas_expense_account === undefined
        const defaults = defaultAccountsForCategory(
          finalCategory,
          company?.accounting_framework,
        )
        const excluded = findK2ExcludedAccount([
          validation.data.bas_asset_account ??
            (categoryDefaultsApply ? defaults.asset : existing.bas_asset_account),
          validation.data.bas_accumulated_account ??
            (categoryDefaultsApply ? defaults.accumulated : existing.bas_accumulated_account),
        ])
        if (excluded) {
          const messages = k2ExcludedAccountMessages(excluded, company?.entity_type)
          return NextResponse.json(
            {
              error: {
                code: 'K2_EXCLUDED_ACCOUNT',
                message: messages.message_sv,
                message_en: messages.message_en,
              },
            },
            { status: 422 },
          )
        }
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
