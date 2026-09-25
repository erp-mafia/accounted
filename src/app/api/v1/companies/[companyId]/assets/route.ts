/**
 * GET  /api/v1/companies/{companyId}/assets
 * POST /api/v1/companies/{companyId}/assets
 *
 * The fixed-asset register (anläggningsregister). The listing carries
 * has_posted_depreciation so a client knows which rows can still take a
 * basis correction. Creating registers the asset only: the acquisition is
 * assumed to already be in the books (bank payment or supplier invoice), so
 * no voucher is posted here. Depreciation is proposed and posted per fiscal
 * period through the year-end flow.
 *
 * Contracts and framework gates are shared with the dashboard routes and the
 * MCP tools via lib/bokslut/assets/asset-api.ts.
 */
import { z } from 'zod'
import { ok, created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { createAsset, listAssets } from '@/lib/bokslut/assets/asset-service'
import {
  AssetViewSchema,
  CreateAssetSchema,
  assetView,
  checkCreateAssetGates,
  loadPostedDepreciationAssetIds,
  resolveCreateAccounts,
} from '@/lib/bokslut/assets/asset-api'

const AssetShape = AssetViewSchema.extend({ id: z.string().uuid() })

const ListQuery = z.object({
  active_only: z
    .enum(['true', 'false'])
    .optional()
    .describe('true returns only assets that have not been disposed. Default: the whole register.'),
})

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
  notes: null,
  disposed_at: null,
  disposal_type: null,
  disposed_proceeds: null,
  disposal_journal_entry_id: null,
  has_posted_depreciation: false,
  deletable: true,
  created_at: '2026-03-01T09:12:00.000Z',
  updated_at: '2026-03-01T09:12:00.000Z',
}

registerEndpoint({
  operation: 'assets.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/assets',
  summary: 'List the fixed-asset register (anläggningsregister).',
  description:
    'Returns every asset in the register with its category, acquisition basis, useful life, BAS account triple, disposal state and has_posted_depreciation. Pass ?active_only=true to leave out disposed assets.',
  useWhen:
    'You need the anläggningsregister: before proposing depreciation, to check which assets are still open, or to find the asset id for an update or disposal.',
  doNotUseFor:
    'The bookkept balance on 12xx accounts (use the trial balance or balance sheet). Proposing or posting depreciation (fiscal-periods year-end flow).',
  pitfalls: [
    'has_posted_depreciation=true locks acquisition_date, acquisition_cost and category: PATCH returns 409 ASSET_CORRECTION_BLOCKED and a correction goes through storno.',
    'Disposed assets stay in the register with disposed_at set (BFL retention); filter with active_only=true when you want the open ones.',
    'acquisition_cost is excl. VAT. The purchase voucher is not linked here: the register does not post anything on create.',
  ],
  example: {
    response: {
      data: { assets: [EXAMPLE_ASSET] },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: dataEnvelope(z.object({ assets: z.array(AssetShape) })) },
})

registerEndpoint({
  operation: 'assets.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/assets',
  summary: 'Register a fixed asset (no voucher is posted).',
  description:
    'Adds an asset to the anläggningsregister. BAS accounts default per category (framework-aware for intangibles: a K2 company lands on 1090/1099). No journal entry is posted: the acquisition is already in the books via the bank payment or supplier invoice. Dry-runnable: returns the resolved accounts without writing.',
  useWhen:
    'A purchase over the förbrukningsinventarie threshold (half a prisbasbelopp) or with a useful life over three years has been booked and must be depreciated over time.',
  doNotUseFor:
    'Booking the purchase itself (categorize the bank transaction or register the supplier invoice). Small or short-lived items: expense them on 54xx instead of capitalising.',
  pitfalls: [
    'k3_components is accepted only when the company applies K3: 422 K3_REQUIRED_FOR_COMPONENTS otherwise. Components must sum to acquisition_cost.',
    'opening_accumulated_depreciation must be between 0 and acquisition_cost - salvage_value. A positive amount requires opening_depreciation_date between acquisition_date and today (Europe/Stockholm). Zero clears the opening date.',
    'Opening depreciation registers an amount already in the imported ledger and posts no voucher. Enter the amount for this asset from the previous asset register and manually reconcile the register totals with the imported ledger before depreciation or disposal; no automatic reconciliation is performed.',
    'Opening fields lock after depreciation posted through Accounted\'s asset register or disposal. Manual ledger postings do not lock them.',
    'A positive opening amount cannot be combined with non-empty k3_components. Opening balances for K3 component assets are unsupported; keep the component breakdown.',
    'Account overrides must sit inside the category range (e.g. 1200-1299 for equipment) and may not be flagged Ej K2 for a K2 company (422 K2_EXCLUDED_ACCOUNT).',
    'useful_life_months drives linear depreciation from acquisition_date, pro-rated in the first fiscal year.',
  ],
  example: {
    request: {
      name: 'MacBook Pro 16"',
      category: 'computer',
      acquisition_date: '2026-03-01',
      acquisition_cost: 32000,
      useful_life_months: 36,
    },
    response: {
      data: EXAMPLE_ASSET,
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CreateAssetSchema },
  response: { success: dataEnvelope(AssetShape) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'assets.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const parsed = ListQuery.safeParse({
      active_only: url.searchParams.get('active_only') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    try {
      const assets = await listAssets(ctx.supabase, ctx.companyId!, {
        activeOnly: parsed.data.active_only === 'true',
      })
      const posted = await loadPostedDepreciationAssetIds(
        ctx.supabase,
        ctx.companyId!,
        assets.map((asset) => asset.id),
      )
      return ok(
        { assets: assets.map((asset) => ({ id: asset.id, ...assetView(asset, posted.has(asset.id)) })) },
        { requestId: ctx.requestId },
      )
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'assets.create',
  async (request, ctx) => {
    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = CreateAssetSchema.safeParse(raw.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    const gate = await checkCreateAssetGates(ctx.supabase, ctx.companyId!, body)
    if (gate) {
      return v1ErrorResponseFromCode(gate.code, ctx.log, {
        requestId: ctx.requestId,
        status: gate.status,
        details: { message_sv: gate.message_sv, message_en: gate.message_en, ...gate.details },
      })
    }

    if (ctx.dryRun) {
      // The accounts the row would be created with, resolved the same way
      // createAsset() resolves them: explicit override, else the
      // framework-aware category default.
      const accounts = await resolveCreateAccounts(ctx.supabase, ctx.companyId!, body)
      return dryRunPreview(
        {
          ...body,
          salvage_value: body.salvage_value ?? 0,
          depreciation_method: body.depreciation_method ?? 'linear',
          bas_asset_account: accounts.asset,
          bas_accumulated_account: accounts.accumulated,
          bas_expense_account: accounts.expense,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    try {
      const asset = await createAsset(ctx.supabase, ctx.companyId!, ctx.userId, body)
      return created({ id: asset.id, ...assetView(asset, false) }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
