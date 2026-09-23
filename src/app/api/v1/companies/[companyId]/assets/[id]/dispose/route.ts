/**
 * POST /api/v1/companies/{companyId}/assets/{id}/dispose
 *
 * Takes an asset out of the register by sale, scrap (utrangering) or
 * business transfer, and posts the avyttring voucher: current-year
 * depreciation up to the disposal date, reversal of cost and accumulated
 * depreciation, proceeds with output VAT when taxable, the gain (3973/3972)
 * or loss (7973/7972), and the ML 15 kap. jämkning of input VAT when the
 * asset is an investment good. Dry-run returns the exact plan without
 * writing anything; the commit books it atomically.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { disposeAsset, previewAssetDisposal } from '@/lib/bokslut/assets/asset-service'
import {
  AssetViewSchema,
  DisposalPreviewSchema,
  DisposeAssetSchema,
  assetView,
  disposalPreviewView,
} from '@/lib/bokslut/assets/asset-api'

const AssetShape = AssetViewSchema.extend({ id: z.string().uuid() })

const DisposalResponse = z.object({
  asset: AssetShape,
  // Null when nothing needed posting (a fully depreciated asset scrapped for
  // nothing): the register row is still marked disposed.
  disposal_entry: z
    .object({
      journal_entry_id: z.string(),
      voucher_number: z.number().nullable(),
    })
    .nullable(),
  gain_or_loss: z.number(),
})

registerEndpoint({
  operation: 'assets.dispose',
  method: 'POST',
  path: '/api/v1/companies/:companyId/assets/:id/dispose',
  summary: 'Dispose a fixed asset and post the avyttring voucher.',
  description:
    'Marks the asset disposed (sale, scrap or business_transfer) and posts one voucher in the given fiscal period: depreciation up to disposed_at, reversal of acquisition cost and accumulated depreciation, proceeds (with output VAT for a taxable sale) and the resulting gain or loss. Investment goods over the ML 15 kap. thresholds get an input-VAT jämkning when the original VAT data is supplied. Dry-run returns the plan (lines, gain_or_loss, jämkning) without writing.',
  useWhen:
    'An asset has been sold, scrapped or transferred with the business and the register plus the ledger must reflect it. Run a dry-run first and show the plan to the user.',
  doNotUseFor:
    'Correcting a register mistake (PATCH the asset). Posting annual depreciation (year-end flow). Reversing a disposal (storno the disposal voucher).',
  pitfalls: [
    'scrap requires disposed_proceeds=0; a sale with proceeds requires vat_treatment. disposed_proceeds is gross incl. VAT for a taxable sale.',
    '409 ASSET_DISPOSAL_BLOCKED when depreciation is already posted for a later period than the one you dispose in: reverse those postings first.',
    '422 ASSET_JAMKNING_DATA_REQUIRED when the asset is an investment good and jamkning_original_input_vat + jamkning_original_deduction_percent are missing. business_transfer additionally needs business_transfer_confirmed=true and, when the obligation transfers, adjustment_document_confirmed=true.',
    'The fiscal period must be open: closed or locked periods are refused by the ledger triggers.',
  ],
  example: {
    request: {
      disposal_type: 'sale',
      disposed_at: '2026-09-15',
      disposed_proceeds: 12500,
      vat_treatment: 'standard_25',
      fiscal_period_id: 'fp_…',
    },
    response: {
      data: {
        asset: {
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
          disposed_at: '2026-09-15',
          disposal_type: 'sale',
          disposed_proceeds: 12500,
          disposal_journal_entry_id: 'je_…',
          has_posted_depreciation: true,
          deletable: false,
          created_at: '2026-03-01T09:12:00.000Z',
          updated_at: '2026-09-15T10:00:00.000Z',
        },
        disposal_entry: { journal_entry_id: 'je_…', voucher_number: 118 },
        gain_or_loss: -16222.22,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: DisposeAssetSchema },
  response: { success: dataEnvelope(DisposalResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'assets.dispose',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Asset id must be a UUID.' },
      })
    }
    const assetId = idParse.data

    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = DisposeAssetSchema.safeParse(raw.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    try {
      if (ctx.dryRun) {
        const preview = await previewAssetDisposal(ctx.supabase, ctx.companyId!, assetId, body)
        return dryRunPreview(disposalPreviewView(preview, body), {
          requestId: ctx.requestId,
          log: ctx.log,
        })
      }

      const result = await disposeAsset(ctx.supabase, ctx.companyId!, ctx.userId, assetId, body)
      return ok(
        {
          // The disposal voucher carries the year's depreciation, so the
          // basis is locked from here on regardless of earlier postings.
          asset: { id: result.asset.id, ...assetView(result.asset, true) },
          disposal_entry: result.disposal_entry
            ? {
                journal_entry_id: result.disposal_entry.id,
                voucher_number: result.disposal_entry.voucher_number ?? null,
              }
            : null,
          gain_or_loss: result.gain_or_loss,
        },
        { requestId: ctx.requestId },
      )
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireIdempotencyKey: true },
)
