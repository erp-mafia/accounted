import { NextResponse } from 'next/server'
import { withOmbraAuth } from '@/lib/integrations/ombra/auth'
import { publishToObxRegistry } from '@/lib/obx/registry'

/**
 * POST /api/integrations/ombra/obx/registry
 * Publish manifest hash (+ optional inner hash / chain_root) for third-party attest.
 * Does not import ledger rows (ADR 014).
 */
export async function POST(request: Request) {
  return withOmbraAuth(request, async (ctx) => {
    try {
      const body = (await request.json()) as {
        fiscal_year?: string | number
        manifest_hash?: string
        inner_manifest_hash?: string
        chain_root?: string
        org_number?: string
        origin_system?: string
      }

      const fiscalYear = String(body.fiscal_year ?? '').trim()
      const manifestHash = String(body.manifest_hash ?? '').trim()
      if (!fiscalYear || !manifestHash) {
        return NextResponse.json(
          { error: 'fiscal_year and manifest_hash are required' },
          { status: 400 },
        )
      }

      const row = await publishToObxRegistry(ctx.supabase, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        fiscalYear,
        manifestHash,
        innerManifestHash: body.inner_manifest_hash,
        chainRoot: body.chain_root,
        orgNumber: body.org_number,
        originSystem: body.origin_system ?? 'ombra-sidecar',
        custodyEvent: {
          type: 'registry_publish',
          at: new Date().toISOString(),
          actor: ctx.userId,
        },
      })

      return NextResponse.json({
        data: {
          id: row.id,
          fiscal_year: row.fiscal_year,
          manifest_hash: row.manifest_hash,
          inner_manifest_hash: row.inner_manifest_hash,
          chain_root: row.chain_root,
          published_at: row.published_at,
        },
      })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Registry publish failed' },
        { status: 500 },
      )
    }
  })
}
