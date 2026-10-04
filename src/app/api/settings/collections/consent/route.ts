import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ConsentBodySchema } from '@/lib/collections/activation-form'
import { recordConsent } from '@/lib/collections/connection-service'
import { readCollectionsEnv } from '@/lib/collections/flags'
import {
  collectionsRouteGate,
  connectionErrorResponse,
  connectionResponse,
  routeServiceDeps,
} from '@/lib/collections/settings-routes'

/**
 * POST /api/settings/collections/consent: an owner or admin has read the
 * provider's terms and agrees to share customer data with it. Creates the
 * connection row (connecting, not started) with the terms version, the data
 * processing terms version, who and when. Nothing leaves the app here.
 */
export const POST = withRouteContext(
  'collections.settings.consent',
  async (request, ctx) => {
    const validation = await validateBody(request, ConsentBodySchema, { log: ctx.log, operation: 'collections.settings.consent' })
    if (!validation.success) return validation.response
    const env = readCollectionsEnv()
    const refused = await collectionsRouteGate(ctx, 'activation', env)
    if (refused) return refused
    try {
      return connectionResponse(await recordConsent(routeServiceDeps(ctx, env), validation.data))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
