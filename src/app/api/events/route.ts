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
import { readLiveMembership, type LiveMembership } from '@/lib/company/company-access'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { minimisePayload } from '@/lib/webhooks/handler'
import {
  closedEventFamilies,
  refusedEventFamily,
  type ScopedEventFamily,
} from '@/lib/webhooks/public-events'
import { isMembershipActive } from '@/lib/entitlements/multi-user'
import { createLogger } from '@/lib/logger'
import { roleAllowsScope } from '@/lib/auth/invoicer-role'
import { mapWithConcurrency } from '@/lib/concurrency'

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

/** The reads of a several-type page run this many at a time. */
const TYPE_READ_CONCURRENCY = 4

/**
 * More distinct types than this, more than there are event types, are read
 * in one query with `in` rather than as that many reads.
 */
const MAX_TYPE_READS = 100

const EVENT_COLUMNS = 'sequence, event_type, entity_id, data, created_at'

interface EventLogRow {
  sequence: number
  event_type: string
  entity_id: string | null
  data: unknown
  created_at: string
}

interface EventPageQuery {
  companyId: string
  after: number | undefined
  limit: number
  /** Distinct event types to read; none reads every type. */
  eventTypes: readonly string[]
  /** Prefixes of the event families the caller may not read. */
  closedPrefixes: readonly string[]
}

type EventPage = { rows: EventLogRow[]; error: PostgrestError | null }

/**
 * One page of a company's events after the cursor, in sequence order.
 *
 * Named types are read one type at a time, each with an equality on
 * event_type: with idx_event_log_company_type_sequence that is one range in
 * sequence order, and the read stops after the page. An `in` filter, which
 * PostgREST sends as `event_type = ANY (...)` even for one type, cannot be
 * served in that order, and the planner walked every event of the company
 * instead: 17 to 34 s for the largest event log, past the 8 s statement
 * timeout (crm#2142).
 *
 * 1. With several types, first the company's newest sequence: the horizon.
 *    Each later read is its own snapshot. Bounded by the horizon they all
 *    see the events committed before it was read, so an event written after
 *    it waits for the next page instead of being passed by the cursor. An
 *    event still being written when the horizon is read, below it, can be
 *    passed when it commits between two of the reads; one read over all the
 *    types passes such an event too when it commits after a later one, so
 *    the feed was never free of that.
 * 2. Per type, the sequences only, at most `limit`: an index-only read, which
 *    the planner takes even where it would walk the table to fetch whole rows
 *    (a type common in the table and absent in the company, on default cost
 *    settings). Each type's first `limit` events after the cursor hold every
 *    event of the merged page.
 * 3. The page's rows, by sequence.
 */
async function readEventPage(supabase: SupabaseClient, q: EventPageQuery): Promise<EventPage> {
  const read = (columns: string) => {
    let query = supabase.from('event_log').select(columns).eq('company_id', q.companyId)
    for (const prefix of q.closedPrefixes) {
      query = query.not('event_type', 'like', `${prefix}%`)
    }
    return query
  }

  if (q.eventTypes.length === 0 || q.eventTypes.length > MAX_TYPE_READS) {
    let query = read(EVENT_COLUMNS).order('sequence', { ascending: true }).limit(q.limit)
    if (q.after !== undefined) query = query.gt('sequence', q.after)
    if (q.eventTypes.length > 0) query = query.in('event_type', [...q.eventTypes])
    const { data, error } = await query
    return { rows: (data ?? []) as unknown as EventLogRow[], error }
  }

  let horizon: number | undefined
  if (q.eventTypes.length > 1) {
    const newest = await supabase
      .from('event_log')
      .select('sequence')
      .eq('company_id', q.companyId)
      .order('sequence', { ascending: false })
      .limit(1)
    if (newest.error) return { rows: [], error: newest.error }
    horizon = (newest.data?.[0] as { sequence: number } | undefined)?.sequence
    // Nothing new since the cursor: no type has an event to read.
    if (horizon === undefined || (q.after !== undefined && horizon <= q.after)) return { rows: [], error: null }
  }

  // After a failed read the rest are not started: the page fails anyway.
  let stopped = false
  const reads = await mapWithConcurrency(q.eventTypes, TYPE_READ_CONCURRENCY, async (eventType) => {
    if (stopped) return { sequences: [] as number[], error: null }
    let query = read('sequence').eq('event_type', eventType).order('sequence', { ascending: true }).limit(q.limit)
    if (q.after !== undefined) query = query.gt('sequence', q.after)
    if (horizon !== undefined) query = query.lte('sequence', horizon)
    const { data, error } = await query
    if (error) stopped = true
    return { sequences: ((data ?? []) as unknown as { sequence: number }[]).map((row) => row.sequence), error }
  })
  const failed = reads.find((r) => r.error)
  if (failed?.error) return { rows: [], error: failed.error }

  const page = reads
    .flatMap((r) => r.sequences)
    .sort((a, b) => a - b)
    .slice(0, q.limit)
  if (page.length === 0) return { rows: [], error: null }

  const { data, error } = await read(EVENT_COLUMNS).in('sequence', page).order('sequence', { ascending: true })
  return { rows: (data ?? []) as unknown as EventLogRow[], error }
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
  // The scoped event families (SCOPED_EVENT_FAMILIES: payroll:read for
  // salary_run.* and agi.*, agent:read for company_question.*) need their
  // scope on an API key, the same gate webhook registration applies: the pull
  // feed must never hand out what the push surface withholds. A session user
  // reads them as in the app.
  let holdsFamilyScope: (scope: ScopedEventFamily['scope']) => boolean = () => true

  const token = extractBearerToken(request)
  if (token?.startsWith('gnubok_sk_')) {
    const authResult = await validateApiKey(token)
    if ('error' in authResult) {
      // validateApiKey returns 401 (bad/unknown/refresh token), 429 (rate
      // limit) or a coded refusal (a paused agent, a suspended service
      // account): map them onto the canonical envelope, same as v1.
      return errorResponseFromCode(
        authResult.code ?? (authResult.status === 429 ? 'RATE_LIMITED' : 'UNAUTHORIZED'),
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
    const keyScopes = authResult.scopes
    holdsFamilyScope = (scope) => hasScope(keyScopes, scope)
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
  // draining the event log of a company its owner no longer belongs to.
  // readLiveMembership is the read the v1 gate and MCP routing make: an
  // archived company is a deactivated tenant and stops feeding automation
  // platforms.
  //
  // The session path is deliberately excluded: it runs on the request-scoped
  // client where RLS (user_company_ids()) already enforces the same rule.
  if (keyCompanyId !== null) {
    let membership: LiveMembership | null
    try {
      membership = await readLiveMembership(supabase, userId, companyId)
    } catch (membershipError) {
      log.error('failed to resolve company membership', membershipError as Error)
      return errorResponseFromCode('INTERNAL_ERROR', log, {
        details: { reason: getUserErrorMessage(membershipError) },
      })
    }

    if (!membership) {
      // 404 rather than 403, matching v1 and MCP: do not confirm the company
      // exists to a caller who is no longer allowed to see it.
      return errorResponseFromCode('NOT_FOUND', log, { details: { companyId } })
    }

    // Multi-user seat gate, as with-api-v1.ts and MCP apply it: a non-owner
    // membership in a frozen company (multi_user lapsed past its grace) gets
    // no events either. Owners pass without a read; no read while the gate
    // is off.
    const { role } = membership
    // The invoicing-only role (lib/auth/invoicer-role.ts) reaches customers,
    // invoices and articles; the event log spans the whole company.
    if (!roleAllowsScope(role, REQUIRED_SCOPE)) {
      log.warn('invoicer membership refused the event log', { companyId })
      return errorResponseFromCode('FORBIDDEN', log, {
        reason: 'role_scope_limited',
        details: { code: 'ROLE_SCOPE_LIMITED', companyId, required_scope: REQUIRED_SCOPE },
      })
    }
    if (!(await isMembershipActive(supabase, companyId, role))) {
      log.warn('multi-user seat gate refused frozen membership', { companyId })
      return errorResponseFromCode('FORBIDDEN', log, {
        reason: 'multi_user_frozen',
        details: {
          companyId,
          capability: 'multi_user',
          message: 'Company is paused for this account: multiple users require a paid plan. Ask the company owner to upgrade.',
        },
      })
    }
  }

  // Validate query params
  const result = validateQuery(request, EventsQuerySchema)
  if (!result.success) return result.response
  const { after, types, limit } = result.data

  // Asking for a type of a scoped family by name without its scope is refused
  // rather than answered with an empty page the caller would poll forever.
  const refused = refusedEventFamily(types ?? [], holdsFamilyScope)
  if (refused) {
    return errorResponseFromCode('INSUFFICIENT_SCOPE', log, {
      details: {
        required_scope: refused.scope,
        reason: `Reading ${refused.eventTypes.join(', ')} requires ${refused.scope} in addition to ${REQUIRED_SCOPE}.`,
      },
    })
  }

  const { rows, error } = await readEventPage(supabase, {
    companyId,
    after,
    limit,
    eventTypes: [...new Set(types ?? [])],
    closedPrefixes: closedEventFamilies(holdsFamilyScope).flatMap((family) => family.prefixes),
  })

  if (error) {
    log.error('event_log query failed', error)
    return errorResponseFromCode('INTERNAL_ERROR', log, {
      details: { reason: getUserErrorMessage(error) },
    })
  }

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
