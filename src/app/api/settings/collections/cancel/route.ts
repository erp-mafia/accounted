import { withRouteContext } from '@/lib/api/with-route-context'
import { endConnection } from '@/lib/collections/connection-service'
import { connectionErrorResponse, connectionResponse, routeServiceDeps } from '@/lib/collections/settings-routes'

/**
 * POST /api/settings/collections/cancel: "Avbryt aktiveringen", any time
 * before the connection is active. Stopping work is never gated: a kill
 * switch or a lapsed plan must not keep an activation alive.
 */
export const POST = withRouteContext(
  'collections.settings.cancel',
  async (_request, ctx) => {
    try {
      return connectionResponse(await endConnection(routeServiceDeps(ctx), 'cancel'))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
