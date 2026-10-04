import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { OnboardingBodySchema } from '@/lib/collections/activation-form'
import { submitOnboarding } from '@/lib/collections/connection-service'
import { readCollectionsEnv } from '@/lib/collections/flags'
import {
  collectionsRouteGate,
  connectionErrorResponse,
  connectionResponse,
  routeServiceDeps,
} from '@/lib/collections/settings-routes'

/** Connect gives onboarding 120 s and the adapter waits 130 s for it. */
export const maxDuration = 150

/**
 * POST /api/settings/collections/onboarding: "Skicka ansökan". The company's
 * details, know-your-customer answers and rules go to the provider through
 * Connect; the rules are stored on the connection first. A timeout leaves
 * the application submitted and the status poll finishes it.
 */
export const POST = withRouteContext(
  'collections.settings.onboarding',
  async (request, ctx) => {
    const validation = await validateBody(request, OnboardingBodySchema, { log: ctx.log, operation: 'collections.settings.onboarding' })
    if (!validation.success) return validation.response
    const env = readCollectionsEnv()
    const refused = await collectionsRouteGate(ctx, 'activation', env)
    if (refused) return refused
    try {
      return connectionResponse(await submitOnboarding(routeServiceDeps(ctx, env), validation.data))
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
