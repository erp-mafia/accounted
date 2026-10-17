/**
 * Single wrapper that gives every API route the same shape:
 *
 *   - generates a request id (`req_<uuid>`) and threads it through the logger
 *   - resolves auth via requireAuth() and (by default) the active companyId
 *   - runs the handler in the commit-actor scope as the signed-in user, so
 *     every verifikat it posts records who committed it and how
 *   - emits one structured `info` log on completion with duration
 *   - converts any thrown value into the canonical error envelope via
 *     errorResponse(); the request id appears in the response body and the
 *     X-Request-Id response header. Unhandled errors are logged ("op failed")
 *     with the resolved { requestId, operation, userId, companyId } context.
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

import '@/lib/server-baseline'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import {
  companyAdminRequiredResponse,
  isCompanyAdmin,
  requireWritePermission,
} from '@/lib/auth/require-write'
import { getActiveCompanyId } from '@/lib/company/context'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'
import { createLogger, type Logger } from '@/lib/logger'
import { shouldExposeTimingHeaders } from '@/lib/observability/timing-headers'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withSIEPeriodRead } from '@/lib/import/sie-period-read'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { startPackageForSessionRequest } from '@/lib/modules/package-doors'
import { packageStartRefusal } from '@/lib/modules/package-gate'

export interface RouteContext {
  /** Stable id for this HTTP request: appears in logs, error envelope, X-Request-Id header. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId, operation }. */
  log: Logger
  /** Authenticated user. Always present: wrapper short-circuits with 401 otherwise. */
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
  /**
   * The caller's role in `companyId` when the resolution already read it
   * (the resolver RPC returns it with the company). Undefined means NOT
   * KNOWN (query fallback path, or a database without the role column), never
   * "no role": hand it to getCompanyRole / requireWritePermission as a known
   * value and they read company_members only when it is missing.
   */
  role?: CompanyRole
}

interface RouteContextOptions {
  /**
   * Defaults to false. When true, the wrapper rejects callers whose role in
   * the active company is `viewer` (or who have no membership). Mirrors the
   * existing requireWritePermission() helper so mutating routes can drop two
   * lines of boilerplate.
   */
  requireWrite?: boolean
  /**
   * Defaults to false. When true, the wrapper rejects callers who are not
   * `owner` or `admin` of the active company, by asking the database the same
   * predicate the admin-only RLS policies evaluate (user_is_company_admin).
   * Use it on every route that writes a table gated by that predicate
   * (company_settings, companies, company_members, company_invitations,
   * api_keys, invoice_payee_defaults): `requireWrite` lets a `member` through
   * and RLS then refuses the write silently, as a zero-row UPDATE. Implies
   * `requireWrite` (owner and admin are non-viewer roles), so the two are
   * never checked together.
   */
  requireAdmin?: boolean
  /** File exports must not escape while a company has an incomplete import. */
  requireCompleteLedger?: boolean | ((request: Request) => boolean)
}

// Next.js 16 always passes a `{ params: Promise<...> }` second arg to route
// handlers: including on non-dynamic routes, where it's `Promise<{}>`. The
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
  const { requireWrite = false, requireAdmin = false } = options

  return async function wrapped(request: Request, params: P): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/${operation}`, { requestId, operation })
    // Upgraded as request context resolves, so an unhandled throw in the catch
    // below is logged with the richest available { userId, companyId } context
    // (audit trail / OWASP V16), not just { requestId, operation }.
    let errLog = log

    try {
      const authStart = Date.now()
      const auth = await requireAuth()
      const authMs = Date.now() - authStart
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
      errLog = userLog

      let companyId: string | null = null
      // The resolver RPC also reports the caller's role in that company, so
      // the write guard below needs no company_members read of its own.
      const resolved: ActiveCompanyFacts = {}
      const companyStart = Date.now()
      try {
        companyId = await getActiveCompanyId(supabase, user.id, resolved)
      } catch (err) {
        userLog.error('failed to resolve active company', err as Error)
      }
      const companyMs = Date.now() - companyStart

      if (!companyId) {
        return errorResponseFromCode('COMPANY_CONTEXT_MISSING', userLog, { requestId })
      }

      if (requireAdmin) {
        if (!(await isCompanyAdmin(supabase, companyId))) {
          return companyAdminRequiredResponse(userLog.child({ companyId }), requestId)
        }
      } else if (requireWrite) {
        // Delegate to the existing helper so tests that already mock it
        // continue to work. The helper returns its own 403 NextResponse;
        // we wrap it in our request-id header for traceability. The
        // company id and role resolved above are handed over so the helper
        // repeats neither the resolve_active_company round trip (measured
        // ~40 ms p50 on prod) nor the company_members role read; it reads
        // the role itself only when the resolution could not report it.
        const writeCheck = await requireWritePermission(supabase, user.id, {
          companyId,
          role: resolved.role,
        })
        if (!writeCheck.ok) {
          userLog.warn('write permission denied')
          if (!writeCheck.response.headers.get('X-Request-Id')) {
            writeCheck.response.headers.set('X-Request-Id', requestId)
          }
          return writeCheck.response
        }
      }

      // A route that starts new work in a package (lib/modules/package-doors.ts)
      // refuses while the company has that package switched off or winding
      // down. Every other route skips this: the match is in memory.
      const startPackage = startPackageForSessionRequest(request.method, new URL(request.url).pathname)
      if (startPackage) {
        const refusal = await packageStartRefusal(supabase, companyId, startPackage)
        if (refusal) {
          return errorResponseFromCode(refusal.code, userLog.child({ companyId }), {
            requestId,
            messageSv: refusal.messageSv,
            messageEn: refusal.messageEn,
            details: refusal.details,
          })
        }
      }

      const ctx: RouteContext = {
        requestId,
        log: userLog.child({ companyId }),
        user,
        supabase,
        companyId,
        role: resolved.role,
      }
      errLog = ctx.log

      const handlerStart = Date.now()
      const requireCompleteLedger = typeof options.requireCompleteLedger === 'function'
        ? options.requireCompleteLedger(request) : options.requireCompleteLedger
      // Every commit the handler makes, however many frames down, is stamped
      // with the signed-in user as its actor (and, through commitEntry, the
      // commit method that implies). A route that relays someone else, such
      // as an approval, opens its own runWithActor scope inside this one.
      const response = await runWithActor({ type: 'user' }, () =>
        requireCompleteLedger
          ? withSIEPeriodRead(supabase, companyId, 'report_export', () => handler(request, ctx, params))
          : handler(request, ctx, params))
      const handlerMs = Date.now() - handlerStart

      if (response instanceof Response && !response.headers.get('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestId)
      }
      // Per-phase breakdown in the op-completed log (always) and, outside
      // production, in browser devtools (Timing tab): separates the wrapper's
      // own overhead (auth round trip + company resolution) from the
      // handler's real work, so latency regressions can be attributed without
      // guessing. Production keeps only the log line: the header would tell
      // any caller how the pipeline is built (lib/observability/timing-headers).
      if (
        response instanceof Response &&
        shouldExposeTimingHeaders() &&
        !response.headers.get('Server-Timing')
      ) {
        response.headers.set(
          'Server-Timing',
          `auth;dur=${authMs}, company;dur=${companyMs}, handler;dur=${handlerMs}`,
        )
      }

      ctx.log.info('op completed', {
        durationMs: Date.now() - start,
        status: response.status,
        authMs,
        companyMs,
        handlerMs,
      })
      return response
    } catch (err) {
      // Resolve the envelope first so the log level can follow the mapped
      // status — thrown 4xx domain errors are expected outcomes (warn), only
      // 5xx are runtime errors. errorResponse logs the error itself at the
      // same threshold.
      const response = errorResponse(err, errLog, { requestId })
      const meta = { durationMs: Date.now() - start, status: response.status }
      if (response.status < 500) errLog.warn('op failed', err as Error, meta)
      else errLog.error('op failed', err as Error, meta)
      return response
    }
  }
}
