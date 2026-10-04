import { withRouteContext } from '@/lib/api/with-route-context'
import { endConnection } from '@/lib/collections/connection-service'
import { connectionErrorResponse, connectionResponse, routeServiceDeps } from '@/lib/collections/settings-routes'

/**
 * POST /api/settings/collections/disconnect: "Avsluta kopplingen". Refused
 * while the company has open cases, unbooked collected payments or unbooked
 * settlements (409 COLLECTIONS_DISCONNECT_BLOCKED; the database refuses it
 * too). The agreement with the provider is ended outside the app, per its
 * terms.
 */
export const POST = withRouteContext(
  'collections.settings.disconnect',
  async (_request, ctx) => {
    try {
      return connectionResponse(await endConnection(routeServiceDeps(ctx), 'disconnect'))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
