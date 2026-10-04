import { withRouteContext } from '@/lib/api/with-route-context'
import { refreshConnection } from '@/lib/collections/connection-service'
import { connectionErrorResponse, connectionResponse, routeServiceDeps } from '@/lib/collections/settings-routes'

/**
 * POST /api/settings/collections/refresh: "Uppdatera status". Reads the
 * connection at the provider and stores what it says. Starts nothing, so no
 * start gate: a company whose start gates have closed still sees where its
 * connection stands.
 */
export const POST = withRouteContext(
  'collections.settings.refresh',
  async (_request, ctx) => {
    try {
      return connectionResponse(await refreshConnection(routeServiceDeps(ctx)))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
