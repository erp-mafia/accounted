import { NextResponse } from 'next/server'
import { frameworkOnDate } from '@/lib/company/accounting-framework'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  createAsset,
  listAssets,
  defaultAccountsForCategory,
  assetDeleteBlockReason,
} from '@/lib/bokslut/assets/asset-service'
import { CreateAssetSchema, loadPostedDepreciationAssetIds } from '@/lib/bokslut/assets/asset-api'
import {
  findK2ExcludedAccount,
  k2ExcludedAccountMessages,
} from '@/lib/bokslut/assets/k2-account-guard'

export const GET = withRouteContext('assets.list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const url = new URL(request.url)
  const activeOnly = url.searchParams.get('active') === 'true'
  try {
    const data = await listAssets(supabase, companyId, { activeOnly })

    // Annotate each asset with whether any depreciation has been posted
    // against it. The UI uses this to lock the acquisition-basis fields
    // (date/cost/category): once avskrivningar are booked a correction must
    // go through storno (the service enforces the same rule server-side).
    // The same read v1 and MCP use: paged, so a register past 1,000
    // schedule rows does not unlock an asset whose rows came later.
    const postedAssetIds = await loadPostedDepreciationAssetIds(
      supabase,
      companyId,
      data.map((a) => a.id),
    )

    // deletable: a row that never reached the books (no posted depreciation,
    // not disposed) may be removed with DELETE /api/assets/[id]; the UI shows
    // "Ta bort" only then. Same rule the delete enforces server-side.
    const annotated = data.map((asset) => {
      const posted = postedAssetIds.has(asset.id)
      return {
        ...asset,
        has_posted_depreciation: posted,
        deletable: assetDeleteBlockReason(asset, posted) === null,
      }
    })
    return NextResponse.json({ data: annotated })
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
    // Framework gates. One companies fetch serves both checks:
    // 1. K3_REQUIRED_FOR_COMPONENTS: K3 component depreciation is only
    //    meaningful when the company applies the K3 framework. Reject the
    //    write with 422 (Unprocessable Entity) rather than silently dropping
    //    the field so the user knows their input was discarded.
    // 2. K2_EXCLUDED_ACCOUNT: accounts flagged k2_excluded ("Ej K2") in the
    //    BAS reference may not carry assets under K2. Checked on the RESOLVED
    //    accounts, mirroring what createAsset() will persist: an explicit
    //    override, or the framework-aware category default (a non-K3 company's
    //    immaterial default is the acquired pair 1090/1099, which is lawful,
    //    so only a deliberate override can trip this). The guard supplies the
    //    message: the egenupparbetade group cites BFNAR 2016:10 punkt 10.4,
    //    other Ej K2 accounts do not, and an enskild firma gets neither, since
    //    K2 is not its regelverk. entity_type rides along on the same fetch.
    // The framework of the year the asset is acquired in, not the company's
    // latest (a next year elected K3 leaves the current year K2).
    const [{ data: company }, framework] = await Promise.all([
      supabase.from('companies').select('entity_type').eq('id', companyId).single(),
      frameworkOnDate(supabase, companyId, validation.data.acquisition_date),
    ])
    const isK3Company = framework === 'k3'
    if (
      validation.data.k3_components !== undefined &&
      validation.data.k3_components !== null &&
      !isK3Company
    ) {
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
    if (!isK3Company) {
      const defaults = defaultAccountsForCategory(validation.data.category, framework)
      const excluded = findK2ExcludedAccount([
        validation.data.bas_asset_account ?? defaults.asset,
        validation.data.bas_accumulated_account ?? defaults.accumulated,
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
    try {
      const asset = await createAsset(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
