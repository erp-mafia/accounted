/**
 * Single wrapper that gives every API route the same shape:
 *
 *   - generates a request id (`req_<uuid>`) and threads it through the logger
 *   - opens the request's trace scope (lib/observability/trace-context.ts):
 *     the trace of a valid `traceparent` header, else a new one, bound to the
 *     logger and named on the response in X-Trace-Id
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
import { CompanyContextError, type ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'
import { createLogger, type Logger } from '@/lib/logger'
import { shouldExposeTimingHeaders } from '@/lib/observability/timing-headers'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withSIEPeriodRead } from '@/lib/import/sie-period-read'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import { traceIdFromRequest } from '@/lib/observability/trace-context'
import { runRequestInTrace } from '@/lib/observability/trace-context-node'
import { startPackageForSessionRequest } from '@/lib/modules/package-doors'
import { packageStartRefusal } from '@/lib/modules/package-gate'
import { invoicerRouteAccess, isInvoicerRole } from '@/lib/auth/invoicer-role'
import { createCompanyScopedClient } from '@/lib/auth/company-scoped-client'
import { sessionShadow, type TodayOutcome } from '@/lib/permissions/shadow'

export interface RouteContext {
  /** Stable id for this HTTP request: appears in logs, error envelope, X-Request-Id header. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId, operation }. */
  log: Logger
  /** Authenticated user. Always present: wrapper short-circuits with 401 otherwise. */
  user: User
  /**
   * Authenticated Supabase client (request-scoped, RLS active). For the
   * invoicer role on a `scoped` route (lib/auth/invoicer-role.ts) it is a
   * service-role client that can only reach `companyId`
   * (lib/auth/company-scoped-client.ts).
   */
  supabase: SupabaseClient
  /**
   * Resolved active company id. The wrapper short-circuits before invoking
   * the handler when no company is resolved (resolveSessionCompany:
   * COMPANY_CONTEXT_MISSING, or TRANSIENT_ERROR when the resolution itself
   * failed), so handlers can treat this as guaranteed non-null. Routes that
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

export type SessionCompany = { ok: true; companyId: string } | { ok: false; response: NextResponse }

/**
 * The active company of a cookie-session request, or the answer when there
 * is none. Both session doors resolve through this, withRouteContext and the
 * extension dispatcher (app/api/extensions/ext/[...path]/route.ts), so a
 * route answers alike whichever door it sits behind:
 *
 *   - the user has no company to resolve: COMPANY_CONTEXT_MISSING (400);
 *   - the resolution failed (CompanyContextError 'resolution_failed': a query
 *     that got no answer, lib/company/active-company.ts): TRANSIENT_ERROR
 *     (503, retryable). The active company is unknown for the moment, not
 *     absent: "Välj ett företag" would be the wrong answer, and no other
 *     company is tried in its place.
 *
 * `facts` receives what the resolution reported (the caller's role). Any
 * other throw is not an answer about the company and propagates.
 */
export async function resolveSessionCompany(
  supabase: SupabaseClient,
  userId: string,
  facts: ActiveCompanyFacts,
  log: Logger,
  requestId: string,
): Promise<SessionCompany> {
  let companyId: string | null
  try {
    companyId = await getActiveCompanyId(supabase, userId, facts)
  } catch (err) {
    if (!(err instanceof CompanyContextError && err.code === 'resolution_failed')) throw err
    log.error('failed to resolve active company', err)
    return {
      ok: false,
      response: errorResponseFromCode('TRANSIENT_ERROR', log, { requestId, reason: 'active company resolution failed' }),
    }
  }
  if (!companyId) {
    return { ok: false, response: errorResponseFromCode('COMPANY_CONTEXT_MISSING', log, { requestId }) }
  }
  return { ok: true, companyId }
}

export function withRouteContext<P extends DynamicParams = { params: Promise<Record<string, never>> }>(
  operation: string,
  handler: RouteHandler<P>,
  options: RouteContextOptions = {},
): (request: Request, params: P) => Promise<Response> {
  const { requireWrite = false, requireAdmin = false } = options

  async function handle(request: Request, params: P, traceId: string): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/${operation}`, { requestId, traceId, operation })
    // Upgraded as request context resolves, so an unhandled throw in the catch
    // below is logged with the richest available { userId, companyId } context
    // (audit trail / OWASP V16), not just { requestId, operation }.
    let errLog = log
    // The permission shadow (lib/permissions/shadow.ts): decide() beside the
    // role gates below, told what they did. It reads nothing and changes
    // nothing; a no-op until the role is known.
    let recordShadow: (today: TodayOutcome) => void = () => {}
    let handlerStarted = false

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

      // The resolver RPC also reports the caller's role in that company, so
      // the write guard below needs no company_members read of its own.
      const resolved: ActiveCompanyFacts = {}
      const companyStart = Date.now()
      const company = await resolveSessionCompany(supabase, user.id, resolved, userLog, requestId)
      const companyMs = Date.now() - companyStart

      if (!company.ok) return company.response
      const { companyId } = company

      recordShadow = sessionShadow({
        door: `session:${operation}`,
        method: request.method,
        pathname: new URL(request.url).pathname,
        companyId,
        userId: user.id,
        role: resolved.role,
      })

      // The invoicing-only role reaches the routes on its allowlist and
      // nothing else (lib/auth/invoicer-role.ts). A scoped route runs its
      // handler with a client that can only reach this company: the role
      // writes nothing through its own session. A role the resolution did
      // not report is never the invoicer: the resolver RPC has reported the
      // role since before the role existed, and only service-role clients
      // fall back to the query path.
      let handlerSupabase: SupabaseClient = supabase
      if (isInvoicerRole(resolved.role)) {
        const access = invoicerRouteAccess(request.method, new URL(request.url).pathname)
        if (!access) {
          userLog.warn('invoicer role refused outside its routes')
          recordShadow({ outcome: 'deny', code: 'INVOICER_ROUTE_NOT_ALLOWED', by: 'gate' })
          return errorResponseFromCode('FORBIDDEN', userLog.child({ companyId }), {
            requestId,
            messageSv: 'Rollen Fakturering når bara kunder, fakturor, offerter, order och artiklar.',
            messageEn: 'The Invoicing role reaches only customers, invoices, quotes, orders and articles.',
            details: { code: 'INVOICER_ROUTE_NOT_ALLOWED' },
          })
        }
        if (access === 'scoped') {
          handlerSupabase = createCompanyScopedClient({ companyId, userId: user.id }, userLog.child({ companyId }))
        }
      }

      if (requireAdmin) {
        if (!(await isCompanyAdmin(supabase, companyId))) {
          recordShadow({ outcome: 'deny', code: 'ADMIN_REQUIRED', by: 'gate' })
          return companyAdminRequiredResponse(userLog.child({ companyId }), requestId)
        }
      } else if (requireWrite) {
        // Delegate to the existing helper so tests that already mock it
        // continue to work. The helper returns its own 403 NextResponse;
        // we wrap it in our request-id header for traceability. The
        // company id and role resolved above are handed over so the helper
        // repeats neither the resolve_active_company round trip (measured
        // ~40 ms p50 in production) nor the company_members role read; it reads
        // the role itself only when the resolution could not report it.
        const writeCheck = await requireWritePermission(supabase, user.id, {
          companyId,
          role: resolved.role,
        })
        if (!writeCheck.ok) {
          userLog.warn('write permission denied')
          recordShadow({ outcome: 'deny', code: 'WRITE_REQUIRED', by: 'gate' })
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
        const refusal = await packageStartRefusal(handlerSupabase, companyId, startPackage)
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
        supabase: handlerSupabase,
        companyId,
        role: resolved.role,
      }
      errLog = ctx.log

      const handlerStart = Date.now()
      handlerStarted = true
      const requireCompleteLedger = typeof options.requireCompleteLedger === 'function'
        ? options.requireCompleteLedger(request) : options.requireCompleteLedger
      // Every commit the handler makes, however many frames down, is stamped
      // with the signed-in user as its actor (and, through commitEntry, the
      // commit method that implies). A route that relays someone else, such
      // as an approval, opens its own runWithActor scope inside this one.
      // The user's id rides along so a write the handler makes through a
      // service-role client (the invoicer role's scoped client, a service
      // client) is audited as theirs, not the row creator's.
      const response = await runWithActor({ type: 'user', userId: user.id }, () =>
        requireCompleteLedger
          ? withSIEPeriodRead(handlerSupabase, companyId, 'report_export', () => handler(request, ctx, params))
          : handler(request, ctx, params))
      const handlerMs = Date.now() - handlerStart
      // A 403 from the handler is a check of its own after the gates passed.
      recordShadow(
        response?.status === 403 ? { outcome: 'deny', code: 'HANDLER_FORBIDDEN', by: 'handler' } : { outcome: 'allow' },
      )

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
      // status - thrown 4xx domain errors are expected outcomes (warn), only
      // 5xx are runtime errors. errorResponse logs the error itself at the
      // same threshold.
      const response = errorResponse(err, errLog, { requestId })
      if (handlerStarted) {
        recordShadow(
          response.status === 403 ? { outcome: 'deny', code: 'HANDLER_FORBIDDEN', by: 'handler' } : { outcome: 'allow' },
        )
      }
      const meta = { durationMs: Date.now() - start, status: response.status }
      if (response.status < 500) errLog.warn('op failed', err as Error, meta)
      else errLog.error('op failed', err as Error, meta)
      return response
    }
  }

  return async function wrapped(request: Request, params: P): Promise<Response> {
    const traceId = traceIdFromRequest(request)
    return runRequestInTrace(traceId, () => handle(request, params, traceId))
  }
}
