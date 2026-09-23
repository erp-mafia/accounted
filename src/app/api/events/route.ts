import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import {
  extractBearerToken,
  validateApiKey,
  createServiceClientNoCookies,
  hasScope,
  type ApiKeyMode,
} from '@/lib/auth/api-keys'
import { validateQuery } from '@/lib/api/validate'
import { EventsQuerySchema } from '@/lib/api/schemas'
import { getActiveCompanyId } from '@/lib/company/context'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { minimisePayload } from '@/lib/webhooks/handler'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/events')

/**
 * Scope that gates this endpoint. Declared in lib/auth/api-keys.ts as
 * "Polla händelseloggen (event_log) som webhook-fallback": the scope existed
 * from day one but was never enforced here, so a key holding only
 * DEFAULT_SCOPES (the six read scopes a legacy null-scope key falls back to,
 * none of which is events:read) could still drain the whole event log.
 */
const REQUIRED_SCOPE = 'events:read' as const

/** Response header mirroring the v1 wrapper so integrators can see the key mode. */
const MODE_HEADER = 'X-Gnubok-Mode'

interface EventLogRow {
  sequence: number
  event_type: string
  entity_id: string | null
  data: unknown
  created_at: string
}

/**
 * Project a stored event payload through the same minimisation the webhook
 * fan-out applies (lib/webhooks/handler.ts `minimisePayload`).
 *
 * The event_log row stores the emit-site payload minus userId/companyId
 * (lib/events/handlers/event-log-handler.ts `stripMetaFields`), which is a
 * different and narrower projection than the webhook one. Routing the polled
 * rows through minimisePayload keeps the pull surface from ever handing out
 * more than the push surface for the same event, and means a future tightening
 * (e.g. stripping personnummer from payroll payloads) lands in one place for
 * both. GDPR Art.5(1)(c) data minimisation.
 */
function minimiseEventData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return minimisePayload(value as Record<string, unknown>)
}

/**
 * GET /api/events
 *
 * Cursor-based polling endpoint for external automation platforms (n8n, Make, Zapier).
 * Returns events from the event_log table in sequence order.
 *
 * Query params:
 *   - after (bigint, optional): return events with sequence > this value
 *   - types (string, optional): comma-separated event type filter
 *   - limit (int, optional): max results, default 50, cap 100
 *
 * Supports both session auth (browser) and API key auth (automation platforms).
 */
export async function GET(request: Request) {
  // Dual auth: API key or session. This is a deliberate withRouteContext
  // opt-out: the wrapper is cookie-session only and cannot express the API-key
  // branch. The session branch below still goes through requireAuth(), so MFA
  // (AAL2) stays enforced; the key branch runs the same guards the other two
  // validateApiKey call sites run (lib/api/v1/with-api-v1.ts,
  // extensions/general/mcp-server): scope, then company membership.
  let userId: string
  let supabase: SupabaseClient
  // When authenticated via an API key, the key is BOUND to a specific company.
  // Honor that binding (least privilege) rather than resolving the user's
  // active company: otherwise a key scoped to company A would leak company B's
  // events whenever the user's active_company_id happened to point elsewhere.
  let keyCompanyId: string | null = null
  let keyMode: ApiKeyMode = 'live'

  const token = extractBearerToken(request)
  if (token?.startsWith('gnubok_sk_')) {
    const authResult = await validateApiKey(token)
    if ('error' in authResult) {
      // validateApiKey only ever returns 401 (bad/unknown/refresh token) or
      // 429 (rate limit): map both onto the canonical envelope, same as v1.
      return errorResponseFromCode(
        authResult.status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED',
        log,
        { reason: authResult.error },
      )
    }

    // Guard 1: scope. Mirrors with-api-v1.ts step 4.
    if (!hasScope(authResult.scopes, REQUIRED_SCOPE)) {
      return errorResponseFromCode('INSUFFICIENT_SCOPE', log, {
        details: { required_scope: REQUIRED_SCOPE, granted_scopes: authResult.scopes },
      })
    }

    userId = authResult.userId
    keyCompanyId = authResult.companyId
    // Guard 3: test keys. A test key is simulation-only for WRITES (the v1
    // wrapper forces dry-run and blocks non-simulatable mutations with
    // TEST_KEY_WRITE_BLOCKED). This endpoint has no write path at all, so the
    // consistent behaviour for a read is the one v1 already ships: serve the
    // key's own bound company and label the response, rather than 403 with a
    // "cannot be simulated" message that would be untrue for a GET.
    keyMode = authResult.mode
    // Service-role client: RLS does NOT apply below this line, which is exactly
    // why the membership re-check further down is mandatory.
    supabase = createServiceClientNoCookies()
  } else {
    // Session auth: requireAuth enforces MFA (AAL2) on hosted, unlike a bare
    // getUser call which skips the assurance-level check.
    const auth = await requireAuth()
    if (auth.error) return auth.error
    supabase = auth.supabase
    userId = auth.user.id
  }

  // Session auth resolves the active company; API-key auth uses the key's bound company.
  // A key minted before the user's first company exists (companyless OAuth,
  // issue #1814) has no bound company either; both cases resolve to null and
  // fail closed below rather than throwing.
  const companyId = keyCompanyId ?? await getActiveCompanyId(supabase, userId)
  // Defense in depth: never run the event_log query with an empty/undefined
  // scope. A user with no company resolves to null, and the guard also covers
  // a malformed key binding so it can't widen the query scope.
  if (!companyId) {
    return errorResponseFromCode('FORBIDDEN', log)
  }

  // Guard 2: membership re-check, API-key path only.
  //
  // company_id on the api_keys row is a snapshot taken when the key was minted.
  // Offboarding a user from a company does not revoke their keys, and the
  // service-role client above bypasses RLS, so without this the key keeps
  // draining the event log of a company its owner no longer belongs to. Both
  // sibling call sites already re-check (with-api-v1.ts :349-370 and
  // mcp-server/company-routing.ts :90-102); this closes the third.
  //
  // archived_at IS NULL follows company-routing: an archived company is a
  // deactivated tenant and should stop feeding automation platforms.
  //
  // The session path is deliberately excluded: it runs on the request-scoped
  // client where RLS (user_company_ids()) already enforces the same rule.
  if (keyCompanyId !== null) {
    const { data: membership, error: membershipError } = await supabase
      .from('company_members')
      .select('company_id, companies!inner(archived_at)')
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .is('companies.archived_at', null)
      .maybeSingle()

    if (membershipError) {
      log.error('failed to resolve company membership', membershipError)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        details: { reason: getUserErrorMessage(membershipError) },
      })
    }

    if (!membership) {
      // 404 rather than 403, matching v1 and MCP: do not confirm the company
      // exists to a caller who is no longer allowed to see it.
      return errorResponseFromCode('NOT_FOUND', log, { details: { companyId } })
    }
  }

  // Validate query params
  const result = validateQuery(request, EventsQuerySchema)
  if (!result.success) return result.response
  const { after, types, limit } = result.data

  // Build query
  let query = supabase
    .from('event_log')
    .select('sequence, event_type, entity_id, data, created_at')
    .eq('company_id', companyId)
    .order('sequence', { ascending: true })
    .limit(limit)

  if (after !== undefined) {
    query = query.gt('sequence', after)
  }

  if (types && types.length > 0) {
    query = query.in('event_type', types)
  }

  const { data, error } = await query

  if (error) {
    log.error('event_log query failed', error)
    return errorResponseFromCode('INTERNAL_ERROR', log, {
      details: { reason: getUserErrorMessage(error) },
    })
  }

  const rows = (data ?? []) as EventLogRow[]
  const events = rows.map((row) => ({ ...row, data: minimiseEventData(row.data) }))

  const response = NextResponse.json({
    data: events,
    cursor: events.length > 0 ? events[events.length - 1].sequence : (after ?? 0),
    has_more: events.length === limit,
  })

  // Signal test mode the same way the v1 wrapper does, so an integrator can see
  // which key mode served the response without inspecting the body.
  if (keyMode === 'test') {
    response.headers.set(MODE_HEADER, 'test')
  }

  return response
}
