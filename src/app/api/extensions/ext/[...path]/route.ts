import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { requireCompanyId } from '@/lib/company/context'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import { isInvoicerRole } from '@/lib/auth/invoicer-role'
import {
  companyAdminRequiredResponse,
  isCompanyAdmin,
  requireWritePermission,
} from '@/lib/auth/require-write'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtensionId } from '@/lib/extensions/sectors'
import { createLogger } from '@/lib/logger'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { ApiRouteDefinition } from '@/lib/extensions/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { startPackageForKey } from '@/lib/modules/package-doors'
import { packageStartRefusal } from '@/lib/modules/package-gate'
import { readCompletionLog, shouldWriteCompletionLog } from '@/lib/extensions/completion-log'
import { sessionShadow } from '@/lib/permissions/shadow'

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

// Heavy extension routes (SIE import, entity migration) hold one request
// open for the whole job. 800 s is the Pro-plan ceiling with Fluid compute
// (the default is 300). The migration budgets itself against
// MIGRATE_RUN_BUDGET_MS in extensions/general/arcim-migration/index.ts so it
// hands back its result before this fires: a Björn Lundén company with 9 415
// customer invoices was killed at 300 s on every attempt (2026-09-07).
export const maxDuration = 800

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
  const extension = await extensionRegistry.get(extensionId)
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
  const route = matchedRoute

  // For skipAuth routes (e.g. OAuth callbacks from external providers),
  // skip user auth, toggle check, and AI consent: dispatch immediately
  if (route.skipAuth) {
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
    const response = await route.handler(handlerRequest)
    // The handler may name the call (the MCP endpoint: method, tool, key) or
    // mark it as protocol chatter that needs no line (lib/extensions/completion-log.ts).
    const note = readCompletionLog(handlerRequest)
    if (shouldWriteCompletionLog(note, response.status)) {
      log.info('extension call completed', {
        durationMs: Date.now() - start,
        status: response.status,
        ...note?.fields,
      })
    }
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
  if (route.skipCompanyContext) {
    const response = await route.handler(handlerRequest)
    log.info('extension call completed', {
      durationMs: Date.now() - start,
      status: response.status,
      userId: user.id,
    })
    return decorateResponse(response, requestId)
  }

  // The resolver also reports the caller's role, so the gates below need no
  // company_members read of their own.
  const resolved: ActiveCompanyFacts = {}
  const companyId = await requireCompanyId(supabase, user.id, resolved)

  // The permission shadow (lib/permissions/shadow.ts): decide() beside the
  // role gates below, told what they did. It reads nothing and changes nothing.
  const recordShadow = sessionShadow({
    door: `ext:${extensionId}${route.path}`,
    method,
    pathname: new URL(request.url).pathname,
    companyId,
    userId: user.id,
    role: resolved.role,
  })

  // The invoicing-only role reaches no extension route: INVOICER_ROUTES
  // lists none, and a handler may read through a service client that RLS
  // does not narrow (lib/auth/invoicer-role.ts).
  if (isInvoicerRole(resolved.role)) {
    log.warn('extension call blocked: invoicer role', { userId: user.id })
    recordShadow({ outcome: 'deny', code: 'INVOICER_ROUTE_NOT_ALLOWED', by: 'gate' })
    return decorateResponse(
      errorResponseFromCode('FORBIDDEN', log, {
        requestId,
        messageSv: 'Rollen Fakturering når bara kunder, fakturor, offerter, order och artiklar.',
        messageEn: 'The Invoicing role reaches only customers, invoices, quotes, orders and articles.',
        details: { code: 'INVOICER_ROUTE_NOT_ALLOWED' },
      }),
      requestId,
    )
  }

  // Role gates the route declares, checked as withRouteContext checks them,
  // so a handler never repeats them: requireAdmin asks the database's own
  // owner/admin predicate, requireWrite refuses viewers. A write method
  // refuses viewers by default: only a route that declares viewerMay
  // (lib/extensions/types.ts) lets one through.
  if (route.requireAdmin) {
    if (!(await isCompanyAdmin(supabase, companyId))) {
      recordShadow({ outcome: 'deny', code: 'ADMIN_REQUIRED', by: 'gate' })
      return decorateResponse(companyAdminRequiredResponse(log, requestId), requestId)
    }
  } else if (route.requireWrite || (route.method !== 'GET' && route.viewerMay !== true)) {
    const writeCheck = await requireWritePermission(supabase, user.id, { companyId, role: resolved.role })
    if (!writeCheck.ok) {
      log.warn('extension call blocked: write permission denied', { userId: user.id })
      recordShadow({ outcome: 'deny', code: 'WRITE_REQUIRED', by: 'gate' })
      return decorateResponse(writeCheck.response, requestId)
    }
  }

  // Paywall: this dispatcher is the single chokepoint for the whole enabled-
  // extension API surface (same reasoning as the MFA gate above), so an
  // extension whose workspace is a paid service (EXTENSION_REQUIRED_CAPABILITY,
  // e.g. the AI-only invoice-inbox) gates EVERY one of its company-context routes
  // here, not just its AI-extraction steps. Mirrors the sidebar/page gate off the
  // same map. The skipAuth ingestion webhook (/inbound) returned above is exempt
  // by construction: a lapsed company's inbound documents must still be stored
  // (freeze-and-retain), and booked documents stay reachable via the verifikat.
  const requiredCapability = requiredCapabilityForExtensionId(extensionId)
  if (requiredCapability) {
    const blocked = await requireCapability(supabase, companyId, requiredCapability)
    if (blocked) {
      log.info('extension call blocked: capability required', { capability: requiredCapability })
      return decorateResponse(blocked, requestId)
    }
  }

  // A route that starts new work in a package (a new webshop, till, bank or
  // mail connection; lib/modules/package-doors.ts) refuses while the company
  // has that package switched off or winding down, as withRouteContext does.
  const startPackage = startPackageForKey(`${method} /api/extensions/ext/${extensionId}${route.path}`)
  if (startPackage) {
    const refusal = await packageStartRefusal(supabase, companyId, startPackage)
    if (refusal) {
      log.info('extension call blocked: package off', { packageId: refusal.packageId })
      return decorateResponse(
        errorResponseFromCode(refusal.code, log, {
          requestId,
          messageSv: refusal.messageSv,
          messageEn: refusal.messageEn,
          details: refusal.details,
        }),
        requestId,
      )
    }
  }

  // Build context and dispatch. The second cookie-session door besides
  // withRouteContext: commits an extension makes (inbox booking, supplier
  // invoices) record the signed-in user as their actor, as there, and so do
  // the audit rows of its service-role writes.
  const ctx = createExtensionContext(supabase, user.id, companyId, extensionId, requestId, Boolean(user.is_anonymous))
  const response = await runWithActor({ type: 'user', userId: user.id }, () => route.handler(handlerRequest, ctx))
  // A 403 from the handler is a check of its own after the gates passed.
  recordShadow(
    response?.status === 403 ? { outcome: 'deny', code: 'HANDLER_FORBIDDEN', by: 'handler' } : { outcome: 'allow' },
  )
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
