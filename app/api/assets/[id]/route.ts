import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  getAsset,
  updateAsset,
  deleteNeverPostedAsset,
  defaultAccountsForCategory,
  hasPostedDepreciation,
  assetDeleteBlockReason,
} from '@/lib/bokslut/assets/asset-service'
import { UpdateAssetSchema } from '@/lib/bokslut/assets/asset-api'
import { validateComponents } from '@/lib/bokslut/assets/k3-components'
import {
  findK2ExcludedAccount,
  k2ExcludedAccountMessages,
} from '@/lib/bokslut/assets/k2-account-guard'

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
      // Same annotation as the list: the UI locks the basis fields on
      // has_posted_depreciation and offers "Ta bort" only on deletable.
      const posted = await hasPostedDepreciation(supabase, companyId, asset.id)
      return NextResponse.json({
        data: {
          ...asset,
          has_posted_depreciation: posted,
          deletable: assetDeleteBlockReason(asset, posted) === null,
        },
      })
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

/**
 * Remove a register row that never reached the books. The service refuses
 * (409 ASSET_DELETE_BLOCKED) once depreciation is posted or the asset is
 * disposed: those rows are räkenskapsinformation and leave through disposal
 * or storno only. No voucher is touched either way.
 */
export const DELETE = withRouteContext(
  'assets.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const deleted = await deleteNeverPostedAsset(supabase, companyId, id)
      log.info('asset removed from register (never posted)', {
        assetId: deleted.id,
        name: deleted.name,
        acquisitionCost: deleted.acquisition_cost,
      })
      return NextResponse.json({ data: { id: deleted.id, deleted: true } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
