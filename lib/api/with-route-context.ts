/**
 * Single wrapper that gives every API route the same shape:
 *
 *   - generates a request id (`req_<uuid>`) and threads it through the logger
 *   - resolves auth via requireAuth() and (by default) the active companyId
 *   - emits one structured `info` log on completion with duration
 *   - converts any thrown value into the canonical error envelope via
 *     errorResponse(); the request id appears in the response body and the
 *     X-Request-Id response header
 *
 * Usage:
 *   export const POST = withRouteContext('invoice.send', async (req, ctx) => {
 *     // ctx.requestId, ctx.log, ctx.user, ctx.supabase, ctx.companyId
 *     const result = await sendInvoice(...)
 *     return NextResponse.json({ data: result })
 *   })
 *
 * For dynamic routes the second parameter is the Next.js params promise:
 *   export const POST = withRouteContext('invoice.send', async (req, ctx, { params }) => {
 *     const { id } = await params
 *     ...
 *   })
 */

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger, type Logger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

export interface RouteContext {
  /** Stable id for this HTTP request — appears in logs, error envelope, X-Request-Id header. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId, operation }. */
  log: Logger
  /** Authenticated user. Always present — wrapper short-circuits with 401 otherwise. */
  user: User
  /** Authenticated Supabase client (request-scoped, RLS active). */
  supabase: SupabaseClient
  /**
   * Resolved active company id. The wrapper short-circuits with
   * COMPANY_CONTEXT_MISSING before invoking the handler when no company is
   * resolved, so handlers can treat this as guaranteed non-null. Routes that
   * need to opt out of the guarantee (e.g. onboarding) shouldn't use
   * withRouteContext.
   *
   * Membership invariant: `getActiveCompanyId` only returns a company the
   * authenticated user is a current member of (it validates
   * `company_members` and excludes archived companies). The handler may
   * therefore treat `companyId` as "a company the caller is authorized to
   * read", and routes that mutate state additionally enforce a non-viewer
   * role via `requireWrite: true`. ASVS V8.2.1 / SOC 2 CC6.3.
   */
  companyId: string
}

interface RouteContextOptions {
  /**
   * Defaults to false. When true, the wrapper rejects callers whose role in
   * the active company is `viewer` (or who have no membership). Mirrors the
   * existing requireWritePermission() helper so mutating routes can drop two
   * lines of boilerplate.
   */
  requireWrite?: boolean
}

// Next.js 16 always passes a `{ params: Promise<...> }` second arg to route
// handlers — including on non-dynamic routes, where it's `Promise<{}>`. The
// generic defaults to that empty shape so static routes type-check without
// having to declare any params at the call site.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type DynamicParams = { params: Promise<Record<string, string | string[]>> } | { params: Promise<{}> }

type RouteHandler<P extends DynamicParams = { params: Promise<Record<string, never>> }> = (
  request: Request,
  ctx: RouteContext,
  params: P,
) => Promise<NextResponse | Response>

function generateRequestId(): string {
  // crypto.randomUUID is available in Node 20+/edge runtimes used by Next.js.
  return `req_${crypto.randomUUID()}`
}

export function withRouteContext<P extends DynamicParams = { params: Promise<Record<string, never>> }>(
  operation: string,
  handler: RouteHandler<P>,
  options: RouteContextOptions = {},
): (request: Request, params: P) => Promise<Response> {
  const { requireWrite = false } = options

  return async function wrapped(request: Request, params: P): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/${operation}`, { requestId, operation })

    try {
      const auth = await requireAuth()
      if (auth.error) {
        log.warn('auth failed', { status: auth.error.status })
        // Pass through requireAuth's response unchanged for backwards-compat
        // with existing route tests; only inject the request id header so
        // support can still trace the request.
        if (!auth.error.headers.get('X-Request-Id')) {
          auth.error.headers.set('X-Request-Id', requestId)
        }
        return auth.error
      }

      const { user, supabase } = auth
      const userLog = log.child({ userId: user.id })

      let companyId: string | null = null
      try {
        companyId = await getActiveCompanyId(supabase, user.id)
      } catch (err) {
        userLog.error('failed to resolve active company', err as Error)
      }

      if (!companyId) {
        return errorResponseFromCode('COMPANY_CONTEXT_MISSING', userLog, { requestId })
      }

      if (requireWrite) {
        // Delegate to the existing helper so tests that already mock it
        // continue to work. The helper returns its own 403 NextResponse;
        // we wrap it in our request-id header for traceability.
        const writeCheck = await requireWritePermission(supabase, user.id)
        if (!writeCheck.ok) {
          userLog.warn('write permission denied')
          if (!writeCheck.response.headers.get('X-Request-Id')) {
            writeCheck.response.headers.set('X-Request-Id', requestId)
          }
          return writeCheck.response
        }
      }

      const ctx: RouteContext = {
        requestId,
        log: userLog.child({ companyId }),
        user,
        supabase,
        companyId,
      }

      const response = await handler(request, ctx, params)

      if (response instanceof Response && !response.headers.get('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestId)
      }

      ctx.log.info('op completed', {
        durationMs: Date.now() - start,
        status: response.status,
      })
      return response
    } catch (err) {
      log.error('op failed', err as Error, { durationMs: Date.now() - start })
      return errorResponse(err, log, { requestId })
    }
  }
}
