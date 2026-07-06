import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'

// GET /api/agent/conversations
//
// Query params:
//   archived: 'true' | 'false' (default 'false')
//   pinned:   'true' filters to pinned only
//   intent:   'general.help' (or any intent id), filter
//   q:        case-insensitive substring match on title/context_ref
//   limit:    1..200, default 50
//
// Returns: { data: [{ id, intent_id, context_ref, title, pinned, archived,
//                     last_message_at, created_at }] }
//
// Ordered: pinned first (within archived bucket), then last_message_at desc.
// Used by the /chat sidebar and "resume conversation" UI in the sheet.

const ListQuerySchema = z.object({
  archived: z.enum(['true', 'false']).default('false'),
  pinned: z.enum(['true', 'false']).optional(),
  intent: z.string().min(1).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const GET = withRouteContext('agent.conversations.list', async (request, ctx) => {
  const { supabase, companyId, user, log } = ctx

  const validated = validateQuery(request, ListQuerySchema, {
    log,
    operation: 'agent.conversations.list',
  })
  if (!validated.success) return validated.response
  const { archived, pinned, intent, limit } = validated.data
  const q = validated.data.q?.trim() ?? ''

  let query = supabase
    .from('agent_conversations')
    .select(
      'id, intent_id, context_ref, title, pinned, archived, last_message_at, last_message_preview, created_at',
    )
    .eq('company_id', companyId)
    // Conversations are user-scoped within a company — one member must not
    // see another's (see [id]/route.ts). The RLS policy is company-scoped,
    // so this filter is what actually prevents cross-member leakage of
    // titles and last_message_preview snippets.
    .eq('user_id', user.id)
    .eq('archived', archived === 'true')

  if (pinned === 'true') query = query.eq('pinned', true)
  if (intent) query = query.eq('intent_id', intent)
  if (q.length > 0) {
    // Pattern is sanitized via Postgres' percent-handling; ilike accepts the
    // % wildcard and we only inject the user's substring between them.
    const safe = q.replace(/[%_]/g, (m) => `\\${m}`)
    query = query.or(`title.ilike.%${safe}%,context_ref.ilike.%${safe}%`)
  }

  // Sort: pinned first, then most recent message.
  query = query
    .order('pinned', { ascending: false })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  const { data, error } = await query
  if (error) throw error
  return NextResponse.json({ data: data ?? [] })
})
