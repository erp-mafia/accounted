import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { requireByraBrandAccess } from '@/lib/byra/brand-access'
import { clearBrandCache } from '@/lib/branding/resolve'
import { validateBody } from '@/lib/api/validate'
import { ByraBrandUpdateSchema } from '@/lib/api/schemas'

/**
 * GET /api/byra/brand
 * The caller's byrå brand profile for the Varumärke settings section.
 *
 * Team-scoped, not company-scoped: uses requireAuth() directly (like
 * /api/team/members) because the byrå cockpit has no active-company
 * context. requireAuth still enforces MFA (AAL2) on hosted.
 *
 * Reads the brands row directly through the service client instead of the
 * cached resolveBrandForTeam(): the settings form must show what is stored
 * NOW, not a value up to 60s stale (lib/branding/resolve.ts cache).
 */
export async function GET() {
  const { user, error } = await requireAuth()
  if (error) return error

  const serviceClient = createServiceClient()
  const membership = await getByraMembership(serviceClient, user.id)
  if (!membership) {
    return NextResponse.json({ error: 'Endast för byråteam.' }, { status: 403 })
  }

  const { data: brand, error: brandError } = await serviceClient
    .from('brands')
    .select('domain, app_name, logo_url')
    .eq('team_id', membership.teamId)
    .maybeSingle()

  if (brandError) {
    return NextResponse.json({ error: 'Kunde inte hämta varumärket.' }, { status: 500 })
  }

  const canEdit = membership.role === 'owner' || membership.role === 'admin'

  if (!brand) {
    return NextResponse.json({
      data: { hasBrand: false, domain: null, appName: null, logoUrl: null, canEdit },
    })
  }

  return NextResponse.json({
    data: {
      hasBrand: true,
      domain: brand.domain,
      appName: brand.app_name,
      logoUrl: brand.logo_url,
      canEdit,
    },
  })
}

/**
 * PATCH /api/byra/brand
 * Byrå self-service app name (WL-17): the name shown beside the sidebar
 * logo and across branded chrome. Owner/admin only; domain and colors stay
 * ops-managed. Same service-client write path as the logo route.
 */
export async function PATCH(request: Request) {
  const { user, error } = await requireAuth()
  if (error) return error

  const { teamId, serviceClient, errorResponse } = await requireByraBrandAccess(user.id)
  if (errorResponse) return errorResponse

  const validation = await validateBody(request, ByraBrandUpdateSchema)
  if (!validation.success) return validation.response

  const { data: brand } = await serviceClient
    .from('brands')
    .select('id')
    .eq('team_id', teamId)
    .maybeSingle()
  if (!brand) {
    return NextResponse.json({ error: 'Ingen varumärkesprofil är aktiverad ännu.' }, { status: 404 })
  }

  const { error: updateError } = await serviceClient
    .from('brands')
    .update({ app_name: validation.data.appName })
    .eq('team_id', teamId)
  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte uppdatera varumärket.' }, { status: 500 })
  }

  clearBrandCache()
  return NextResponse.json({ data: { app_name: validation.data.appName } })
}
