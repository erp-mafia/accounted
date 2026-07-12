import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { extractBearerToken, validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { validateQuery } from '@/lib/api/validate'
import { EventsQuerySchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  // Dual auth: API key or session
  let userId: string
  let supabase: SupabaseClient
  // When authenticated via an API key, the key is BOUND to a specific company.
  // Honor that binding (least privilege) rather than resolving the user's
  // active company: otherwise a key scoped to company A would leak company B's
  // events whenever the user's active_company_id happened to point elsewhere.
  let keyCompanyId: string | null = null

  const token = extractBearerToken(request)
  if (token?.startsWith('gnubok_sk_')) {
    const authResult = await validateApiKey(token)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    userId = authResult.userId
    keyCompanyId = authResult.companyId
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
  const companyId = keyCompanyId ?? await requireCompanyId(supabase, userId)
  // Defense in depth: never run the event_log query with an empty/undefined
  // scope. requireCompanyId throws when there is no company, but guard the
  // key-bound path too so a malformed binding can't widen the query scope.
  if (!companyId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const events = data ?? []

  return NextResponse.json({
    data: events,
    cursor: events.length > 0 ? events[events.length - 1].sequence : (after ?? 0),
    has_more: events.length === limit,
  })
}
