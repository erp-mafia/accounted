import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { SettingsPatchSchema } from '@/lib/collections/activation-form'
import { getCollectionsAvailability } from '@/lib/collections/availability'
import { getCollectionsProvider } from '@/lib/collections/catalogue'
import { connectionView, loadLiveConnection } from '@/lib/collections/connection'
import { loadActivationContext, updateConnectionSettings } from '@/lib/collections/connection-service'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { chooseCollectionsRoute } from '@/lib/collections/registry'
import {
  collectionsRouteGate,
  connectionErrorResponse,
  connectionResponse,
  routeServiceDeps,
} from '@/lib/collections/settings-routes'

/**
 * GET /api/settings/collections: everything the settings page renders from.
 * Any member may read it (the page shows the status); the activation form's
 * prefill (company details, payout accounts) is returned only to an owner or
 * admin, and only while the application has not been sent. The provider's
 * profile (terms, data processing terms, fees) comes from the Connect
 * catalogue, or the fake's for a sandbox or local development.
 */
export const GET = withRouteContext('collections.settings.get', async (_request, ctx) => {
  const env = readCollectionsEnv()
  const [availability, row, canManage] = await Promise.all([
    getCollectionsAvailability(ctx.supabase, ctx.companyId, { env }),
    loadLiveConnection(ctx.supabase, ctx.companyId),
    isCompanyAdmin(ctx.supabase, ctx.companyId),
  ])
  const route = row?.route ?? chooseCollectionsRoute({ sandbox: availability.sandbox, fakeAdapterRequested: env.fakeAdapterRequested })
  const shown = availability.start !== 'hidden' || row !== null
  const entry = shown ? await getCollectionsProvider(route) : null
  const activation =
    canManage && availability.start !== 'hidden' && (!row || (!row.submitted_at && !row.connection_handle))
      ? await loadActivationContext(ctx.supabase, ctx.companyId)
      : null
  return NextResponse.json(
    {
      data: {
        availability,
        connection: row ? connectionView(row) : null,
        provider: entry ? { profile: entry.provider, features: entry.features } : null,
        activation,
        canManage,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
})

/**
 * PATCH /api/settings/collections: change the rules of the live connection
 * (minimum amount, first step, the reminder fee and late interest the
 * company's terms allow, delivery). Turning delivery on is start work and
 * passes its gate; everything else serves a connection that exists.
 */
export const PATCH = withRouteContext(
  'collections.settings.update',
  async (request, ctx) => {
    const validation = await validateBody(request, SettingsPatchSchema, { log: ctx.log, operation: 'collections.settings.update' })
    if (!validation.success) return validation.response
    const env = readCollectionsEnv()
    if (validation.data.distributionEnabled === true) {
      const current = await loadLiveConnection(ctx.supabase, ctx.companyId)
      if (current && !current.distribution_enabled) {
        const refused = await collectionsRouteGate(ctx, 'delivery_settings', env)
        if (refused) return refused
      }
    }
    try {
      return connectionResponse(await updateConnectionSettings(routeServiceDeps(ctx, env), validation.data))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
