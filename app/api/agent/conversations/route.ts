import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'

// GET /api/agent/conversations
//
// Query params:
//   archived: 'true' | 'false' (default 'false')
//   pinned:   'true' filters to pinned only
//   intent:   'general.help' (or any intent id) — filter
//   q:        case-insensitive substring match on title/context_ref
//   limit:    1..200, default 50
//
// Returns: { data: [{ id, intent_id, context_ref, title, pinned, archived,
//                     last_message_at, created_at }] }
//
// Ordered: pinned first (within archived bucket), then last_message_at desc.
// Used by the /chat sidebar and "resume conversation" UI in the sheet.
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  const url = new URL(request.url)
  const archived = url.searchParams.get('archived') === 'true'
  const pinnedOnly = url.searchParams.get('pinned') === 'true'
  const intent = url.searchParams.get('intent') ?? null
  const q = url.searchParams.get('q')?.trim() ?? ''
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)

  let query = supabase
    .from('agent_conversations')
    .select(
      'id, intent_id, context_ref, title, pinned, archived, last_message_at, last_message_preview, created_at',
    )
    .eq('company_id', companyId)
    .eq('archived', archived)

  if (pinnedOnly) query = query.eq('pinned', true)
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
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data: data ?? [] })
}
