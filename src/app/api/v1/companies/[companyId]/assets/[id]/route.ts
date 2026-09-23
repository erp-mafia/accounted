/**
 * GET    /api/v1/companies/{companyId}/assets/{id}
 * PATCH  /api/v1/companies/{companyId}/assets/{id}
 * DELETE /api/v1/companies/{companyId}/assets/{id}
 *
 * One asset in the anläggningsregister. PATCH is partial; the acquisition
 * basis (date, cost, category) is only writable while nothing has been posted
 * against the asset, otherwise the service answers 409
 * ASSET_CORRECTION_BLOCKED and the correction goes through storno. DELETE
 * removes a row that never reached the books (no posted depreciation, not
 * disposed); anything else answers 409 ASSET_DELETE_BLOCKED.
 */
import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import {
  getAsset,
  updateAsset,
  deleteNeverPostedAsset,
  getAssetDeleteBlock,
  AssetDeleteBlockedError,
} from '@/lib/bokslut/assets/asset-service'
import {
  AssetViewSchema,
  UpdateAssetSchema,
  assetView,
  checkUpdateAssetGates,
  loadPostedDepreciationAssetIds,
} from '@/lib/bokslut/assets/asset-api'
import type { Asset } from '@/types'

const AssetShape = AssetViewSchema.extend({ id: z.string().uuid() })

const EXAMPLE_ASSET = {
  id: '0e9c…',
  name: 'MacBook Pro 16"',
  category: 'computer',
  acquisition_date: '2026-03-01',
  acquisition_cost: 32000,
  salvage_value: 0,
  useful_life_months: 36,
  depreciation_method: 'linear',
  bas_asset_account: '1224',
  bas_accumulated_account: '1229',
  bas_expense_account: '7832',
  k3_components: null,
  opening_accumulated_depreciation: 0,
  opening_depreciation_date: null,
  notes: 'Serienummer C02XY…',
  disposed_at: null,
  disposal_type: null,
  disposed_proceeds: null,
  disposal_journal_entry_id: null,
  has_posted_depreciation: false,
  deletable: true,
  created_at: '2026-03-01T09:12:00.000Z',
  updated_at: '2026-03-02T08:00:00.000Z',
}

registerEndpoint({
  operation: 'assets.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/assets/:id',
  summary: 'Get one fixed asset.',
  description:
    'Returns the asset with its acquisition basis, BAS account triple, K3 components, disposal state and has_posted_depreciation.',
  useWhen: 'You have an asset id from the listing and need the full row before an update or disposal.',
  doNotUseFor: 'Listing the register (GET /assets). The depreciation schedule per period (year-end flow).',
  pitfalls: ['Returns 404 ASSET_NOT_FOUND for an id in another company: assets are company-scoped.'],
  example: {
    response: {
      data: EXAMPLE_ASSET,
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(AssetShape) },
})

registerEndpoint({
  operation: 'assets.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/assets/:id',
  summary: 'Partially update a fixed asset.',
  description:
    'Patches the register row. Name, notes, salvage value and useful life are always editable. Acquisition date, cost and category redefine the depreciation basis and are only accepted while the asset is neither disposed nor depreciated (409 ASSET_CORRECTION_BLOCKED otherwise: reverse with storno first). A category change without explicit accounts realigns the BAS triple to the new category default. Dry-runnable.',
  useWhen:
    'A data-entry mistake in the register, a renamed asset, or a revised useful life. Use dry-run first to see the merged row.',
  doNotUseFor:
    'Taking the asset out of the register (POST /assets/{id}/dispose). Changing the basis after depreciation is posted (storno the postings first).',
  pitfalls: [
    'k3_components: null clears an existing breakdown; a non-null array is validated against the acquisition_cost that will be in effect after the patch and requires K3.',
    'An empty body is rejected with 400 VALIDATION_ERROR.',
    'Account overrides on a K2 company may not land on an Ej K2 account (422 K2_EXCLUDED_ACCOUNT).',
  ],
  example: {
    request: { notes: 'Serienummer C02XY…', useful_life_months: 48 },
    response: {
      data: { ...EXAMPLE_ASSET, useful_life_months: 48 },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateAssetSchema },
  response: { success: dataEnvelope(AssetShape) },
})

registerEndpoint({
  operation: 'assets.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/assets/:id',
  summary: 'Delete an asset that never reached the books.',
  description:
    'Removes a register row that has no posted depreciation and is not disposed, together with its own unposted depreciation drafts. No voucher is touched. A row that has reached the books is räkenskapsinformation (BFL 7 kap.) and is refused with 409 ASSET_DELETE_BLOCKED: dispose it, or reverse the posted voucher with storno first. Dry-run answers 204 without deleting, or the same 409.',
  useWhen:
    'A row was added by mistake (a typo, a migration test row) and deletable is true on GET. Check deletable first: it is the same rule the delete enforces.',
  doNotUseFor:
    'Taking a real asset out of the register (POST /assets/{id}/dispose posts the avyttring voucher). Undoing posted depreciation (storno the voucher). Editing a wrong basis (PATCH).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    '409 ASSET_DELETE_BLOCKED once any planenlig avskrivning is posted or the asset is disposed: the register row is then accounting information and leaves only through disposal or storno.',
    '204 No Content on success: there is no body to parse. A second DELETE answers 404 ASSET_NOT_FOUND.',
    'Hard delete: the row is not archived. Re-create it with POST /assets if it was removed by mistake.',
  ],
  example: {
    response: { data: null, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'bookkeeping:write',
  risk: 'medium',
  idempotent: false,
  reversible: false,
  dryRunSupported: true,
  response: { success: NoBodyResponse, errorCodes: ['ASSET_NOT_FOUND', 'ASSET_DELETE_BLOCKED'] },
})

function invalidId(ctx: { log: Parameters<typeof v1ErrorResponseFromCode>[1]; requestId: string }) {
  return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
    requestId: ctx.requestId,
    details: { field: 'id', message: 'Asset id must be a UUID.' },
  })
}

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'assets.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) return invalidId(ctx)

    try {
      const asset = await getAsset(ctx.supabase, ctx.companyId!, idParse.data)
      if (!asset) {
        return v1ErrorResponseFromCode('ASSET_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }
      const posted = await loadPostedDepreciationAssetIds(ctx.supabase, ctx.companyId!, [asset.id])
      return ok({ id: asset.id, ...assetView(asset, posted.has(asset.id)) }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'assets.update',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) return invalidId(ctx)
    const assetId = idParse.data

    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = UpdateAssetSchema.safeParse(raw.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data
    if (Object.keys(body).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field is required.' },
      })
    }

    try {
      const existing = await getAsset(ctx.supabase, ctx.companyId!, assetId)
      if (!existing) {
        return v1ErrorResponseFromCode('ASSET_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      }

      const gate = await checkUpdateAssetGates(ctx.supabase, ctx.companyId!, body, existing)
      if (gate) {
        return v1ErrorResponseFromCode(gate.code, ctx.log, {
          requestId: ctx.requestId,
          status: gate.status,
          details: { message_sv: gate.message_sv, message_en: gate.message_en, ...gate.details },
        })
      }

      const posted = await loadPostedDepreciationAssetIds(ctx.supabase, ctx.companyId!, [assetId])
      if (ctx.dryRun) {
        // The merged row as the service would persist it, minus the
        // category-driven account realignment (that needs the framework read
        // updateAsset() does itself). The gate above already refused an
        // unlawful account, so the preview cannot promise more than the
        // commit delivers.
        const merged = { ...existing, ...body } as Asset
        return dryRunPreview(
          { id: assetId, ...assetView(merged, posted.has(assetId)) },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }

      const asset = await updateAsset(ctx.supabase, ctx.companyId!, assetId, body)
      return ok({ id: asset.id, ...assetView(asset, posted.has(assetId)) }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'assets.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) return invalidId(ctx)
    const assetId = idParse.data

    try {
      if (ctx.dryRun) {
        // Same checks as the commit, nothing written: the caller learns
        // whether the row can go (204) or why not (404 / 409).
        const existing = await getAsset(ctx.supabase, ctx.companyId!, assetId)
        if (!existing) {
          return v1ErrorResponseFromCode('ASSET_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
        }
        const block = await getAssetDeleteBlock(ctx.supabase, ctx.companyId!, existing)
        if (block) throw new AssetDeleteBlockedError(block)
        return noContent({ requestId: ctx.requestId })
      }

      const deleted = await deleteNeverPostedAsset(ctx.supabase, ctx.companyId!, assetId)
      ctx.log.info('asset removed from register (never posted)', {
        assetId: deleted.id,
        name: deleted.name,
      })
      return noContent({ requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
