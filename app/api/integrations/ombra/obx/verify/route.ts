import { NextResponse } from 'next/server'
import { withOmbraAuth } from '@/lib/integrations/ombra/auth'
import { verifyAgainstObxRegistry } from '@/lib/obx/registry'

/**
 * POST /api/integrations/ombra/obx/verify
 * Attest a manifest / inner_manifest hash against the hosted registry (ADR 014).
 */
export async function POST(request: Request) {
  return withOmbraAuth(request, async (ctx) => {
    try {
      const body = (await request.json()) as {
        manifest_hash?: string
        inner_manifest_hash?: string
        fiscal_year?: string | number
        scope_company?: boolean
      }

      const result = await verifyAgainstObxRegistry(ctx.supabase, {
        companyId: body.scope_company === false ? undefined : ctx.companyId,
        manifestHash: body.manifest_hash,
        innerManifestHash: body.inner_manifest_hash,
        fiscalYear: body.fiscal_year != null ? String(body.fiscal_year) : undefined,
      })

      const status = result.status === 'VERIFIED' ? 200 : 404
      return NextResponse.json(
        {
          status: result.status,
          message: result.message,
          data: result.match
            ? {
                fiscal_year: result.match.fiscal_year,
                manifest_hash: result.match.manifest_hash,
                inner_manifest_hash: result.match.inner_manifest_hash,
                chain_root: result.match.chain_root,
                org_number: result.match.org_number,
                published_at: result.match.published_at,
              }
            : null,
        },
        { status },
      )
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Verify failed' },
        { status: 500 },
      )
    }
  })
}
