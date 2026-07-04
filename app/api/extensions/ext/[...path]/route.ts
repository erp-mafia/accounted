import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { requireCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'
import type { ApiRouteDefinition } from '@/lib/extensions/types'

const dispatcherLog = createLogger('extension-dispatcher')

function generateRequestId(): string {
  return `req_${crypto.randomUUID()}`
}

/**
 * Wrap a Response so support staff can find the inbound request in stdout
 * logs by id:
 *
 *   1. set the `X-Request-Id` header if missing
 *   2. for JSON error envelopes (`{ error: { code, ... } }`) that came back
 *      without a requestId, inject one into the body so the toast can show
 *      `Felreferens: req_…`
 *
 * Non-JSON responses (HTML for OAuth callbacks, file downloads) only get the
 * header: body rewriting is reserved for the canonical envelope shape.
 */
async function decorateResponse(response: Response, requestId: string): Promise<Response> {
  if (!response.headers.get('X-Request-Id')) {
    response.headers.set('X-Request-Id', requestId)
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      try {
        const cloned = response.clone()
        const body = await cloned.json()
        if (
          body &&
          typeof body === 'object' &&
          body.error &&
          typeof body.error === 'object' &&
          typeof body.error.code === 'string' &&
          !body.error.requestId
        ) {
          const augmented = {
            ...body,
            error: { ...body.error, requestId },
          }
          return new NextResponse(JSON.stringify(augmented), {
            status: response.status,
            headers: response.headers,
          })
        }
      } catch {
        // Body wasn't valid JSON: leave it alone.
      }
    }
  }

  return response
}

ensureInitialized()

// Heavy extension routes (SIE import, migration) need up to 5 minutes
export const maxDuration = 300

/**
 * Per-extension runtime feature flags. Lets ops toggle an integration off
 * without redeploying or removing it from extensions.config.json: useful
 * for phased rollouts (dev tenants → design partners → general).
 *
 * The flag is checked on every request. If the env var is not exactly the
 * string "true", the dispatcher returns 503 with `code: 'EXTENSION_DISABLED'`.
 *
 * Server-side env vars only: no NEXT_PUBLIC_ prefix. Next.js inlines
 * NEXT_PUBLIC_* into the client bundle at build time, so a flip on Vercel
 * without a redeploy would create split-brain (server returns 503,
 * client still renders the enabled flow). UI panels detect the 503 by
 * response code, not by reading the flag directly.
 */
const EXTENSION_FEATURE_FLAGS: Record<string, { envVar: string; disabledMessage: string }> = {
  skatteverket: {
    envVar: 'SKATTEVERKET_ENABLED',
    disabledMessage: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
  },
}

/**
 * Match a request path against a route pattern.
 * Supports :param wildcards (e.g., /:id/confirm).
 * Returns extracted params on match, null on mismatch.
 */
function matchPath(
  pattern: string,
  requestPath: string
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const requestParts = requestPath.split('/').filter(Boolean)

  if (patternParts.length !== requestParts.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = requestParts[i]
    } else if (patternParts[i] !== requestParts[i]) {
      return null
    }
  }

  return params
}

/**
 * Catch-all route for extension-declared API routes.
 *
 * URL scheme: /api/extensions/ext/{extensionId}/{...routePath}
 * Example:    /api/extensions/ext/mcp-server/mcp → POST /mcp
 *
 * - Looks up the extension in the registry
 * - Checks the extension toggle (disabled → 403)
 * - Matches method + path pattern to registered apiRoutes
 * - Extracts path params and appends them as URL search params
 * - Builds an ExtensionContext and passes it to the handler
 */
async function handleRequest(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const requestId = generateRequestId()
  const start = Date.now()
  const segments = await params

  if (!segments.path || segments.path.length < 1) {
    return decorateResponse(
      NextResponse.json({ error: 'Invalid extension route' }, { status: 400 }),
      requestId,
    )
  }

  const [extensionId, ...rest] = segments.path
  const routePath = '/' + rest.join('/')
  const method = request.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

  const log = dispatcherLog.child({ requestId, extensionId, routePath, method })

  // Look up extension
  const extension = extensionRegistry.get(extensionId)
  if (!extension || !extension.apiRoutes || extension.apiRoutes.length === 0) {
    log.warn('extension not found')
    return decorateResponse(
      NextResponse.json({ error: 'Extension not found' }, { status: 404 }),
      requestId,
    )
  }

  // Per-extension feature flags. Lets us toggle a single integration off
  // mid-rollout without redeploying or removing it from extensions.config.json.
  // The frontend (SkatteverketPanel, AGIPanel) inspects the 503 + code to
  // render an "extension disabled" empty state.
  const flag = EXTENSION_FEATURE_FLAGS[extensionId]
  if (flag && process.env[flag.envVar] !== 'true') {
    return decorateResponse(
      NextResponse.json(
        { error: flag.disabledMessage, code: 'EXTENSION_DISABLED' },
        { status: 503 },
      ),
      requestId,
    )
  }

  // Match route BEFORE auth so we can check skipAuth (e.g. OAuth callbacks)
  let matchedRoute: ApiRouteDefinition | null = null
  let extractedParams: Record<string, string> = {}

  for (const route of extension.apiRoutes) {
    if (route.method !== method) continue

    const routeParams = matchPath(route.path, routePath)
    if (routeParams !== null) {
      matchedRoute = route
      extractedParams = routeParams
      break
    }
  }

  if (!matchedRoute) {
    return decorateResponse(
      NextResponse.json({ error: 'Route not found' }, { status: 404 }),
      requestId,
    )
  }

  // Config sanity check: these flags are orthogonal and the combination is
  // nonsensical. `skipAuth` already implies no company resolution, so adding
  // `skipCompanyContext: true` is at best redundant, and if a maintainer
  // intended "auth required, no company" but also wrote `skipAuth: true`,
  // the auth requirement would be silently dropped (skipAuth fires first
  // below). Fail loudly instead of masking the mistake.
  if (matchedRoute.skipAuth && matchedRoute.skipCompanyContext) {
    log.error('route misconfigured: skipAuth + skipCompanyContext are mutually exclusive', undefined)
    return decorateResponse(
      NextResponse.json({ error: 'Route misconfigured' }, { status: 500 }),
      requestId,
    )
  }

  // For skipAuth routes (e.g. OAuth callbacks from external providers),
  // skip user auth, toggle check, and AI consent: dispatch immediately
  if (matchedRoute.skipAuth) {
    let handlerRequest = request
    if (Object.keys(extractedParams).length > 0) {
      const url = new URL(request.url)
      for (const [key, value] of Object.entries(extractedParams)) {
        url.searchParams.set(`_${key}`, value)
      }
      const cloned = request.clone()
      handlerRequest = new Request(url.toString(), {
        method: cloned.method,
        headers: cloned.headers,
        body: cloned.body,
        // @ts-expect-error -- duplex needed for streaming body
        duplex: 'half',
      })
    }
    const response = await matchedRoute.handler(handlerRequest)
    log.info('extension call completed', { durationMs: Date.now() - start, status: response.status })
    return decorateResponse(response, requestId)
  }

  // Auth check: requireAuth() enforces MFA (AAL2) on hosted, which the previous
  // inline supabase.auth.getUser() did not. This dispatcher is the single
  // chokepoint for the entire enabled-extension surface (banking sync, document
  // upload/booking, supplier-invoice flows, migration), so enforcing MFA here
  // closes the gap across all of them at once.
  const auth = await requireAuth()
  if (auth.error) {
    return decorateResponse(auth.error, requestId)
  }
  const { user, supabase } = auth

  // If path params were extracted, create a new Request with them as search params
  let handlerRequest = request
  if (Object.keys(extractedParams).length > 0) {
    const url = new URL(request.url)
    for (const [key, value] of Object.entries(extractedParams)) {
      url.searchParams.set(`_${key}`, value)
    }
    // Clone first to avoid body stream locking issues when transferring to new Request
    const cloned = request.clone()
    handlerRequest = new Request(url.toString(), {
      method: cloned.method,
      headers: cloned.headers,
      body: cloned.body,
      // @ts-expect-error -- duplex needed for streaming body
      duplex: 'half',
    })
  }

  // Routes that are authenticated but run before a company exists (TIC
  // /lookup during onboarding, for example) opt out of company resolution.
  // Dispatch without a context: handlers that opt in must not rely on ctx.
  if (matchedRoute.skipCompanyContext) {
    const response = await matchedRoute.handler(handlerRequest)
    log.info('extension call completed', {
      durationMs: Date.now() - start,
      status: response.status,
      userId: user.id,
    })
    return decorateResponse(response, requestId)
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Build context and dispatch
  const ctx = createExtensionContext(supabase, user.id, companyId, extensionId, requestId)
  const response = await matchedRoute.handler(handlerRequest, ctx)
  log.info('extension call completed', {
    durationMs: Date.now() - start,
    status: response.status,
    userId: user.id,
    companyId,
  })
  return decorateResponse(response, requestId)
}

export const GET = handleRequest
export const POST = handleRequest
export const PUT = handleRequest
export const DELETE = handleRequest
export const PATCH = handleRequest
