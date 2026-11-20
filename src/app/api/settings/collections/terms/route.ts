import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { TermsBodySchema } from '@/lib/collections/activation-form'
import { acceptTerms } from '@/lib/collections/connection-service'
import { readCollectionsEnv } from '@/lib/collections/flags'
import {
  collectionsRouteGate,
  connectionErrorResponse,
  connectionResponse,
  routeServiceDeps,
} from '@/lib/collections/settings-routes'

/**
 * POST /api/settings/collections/terms: accept the provider's terms in the
 * version it presents now, when that is not the version consented to before
 * the application (that one is accepted with the application). Stores the
 * version, who and when, then tells the provider.
 */
export const POST = withRouteContext(
  'collections.settings.terms',
  async (request, ctx) => {
    const validation = await validateBody(request, TermsBodySchema, { log: ctx.log, operation: 'collections.settings.terms' })
    if (!validation.success) return validation.response
    const env = readCollectionsEnv()
    const refused = await collectionsRouteGate(ctx, 'activation', env)
    if (refused) return refused
    try {
      return connectionResponse(await acceptTerms(routeServiceDeps(ctx, env), validation.data))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
