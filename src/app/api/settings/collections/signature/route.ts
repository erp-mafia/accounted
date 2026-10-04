import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SignatureBodySchema } from '@/lib/collections/activation-form'
import { startSignature } from '@/lib/collections/connection-service'
import { readCollectionsEnv } from '@/lib/collections/flags'
import {
  collectionsRouteGate,
  connectionErrorResponse,
  connectionResponse,
  routeServiceDeps,
} from '@/lib/collections/settings-routes'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'

/**
 * POST /api/settings/collections/signature: start the signature of the
 * provider's agreement. sendToSigner false answers a signUrl the admin opens
 * in a new tab; true has the provider mail the link to a firmatecknare. The
 * provider returns the signer to this settings page.
 */
export const POST = withRouteContext(
  'collections.settings.signature',
  async (request, ctx) => {
    const validation = await validateBody(request, SignatureBodySchema, { log: ctx.log, operation: 'collections.settings.signature' })
    if (!validation.success) return validation.response
    const env = readCollectionsEnv()
    const refused = await collectionsRouteGate(ctx, 'activation', env)
    if (refused) return refused
    try {
      const origin = await resolveRequestAppOrigin(request)
      const started = await startSignature(routeServiceDeps(ctx, env), validation.data, {
        redirectUrl: `${origin}/settings/collections?signed=1`,
        language: validation.data.language,
      })
      return connectionResponse(started.connection, { signUrl: started.signUrl, signers: started.signers })
    } catch (error) {
      return connectionErrorResponse(error, ctx)
    }
  },
  { requireAdmin: true },
)
