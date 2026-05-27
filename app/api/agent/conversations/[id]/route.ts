import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// GET /api/agent/conversations/[id]
//
// Returns one conversation + its messages in chronological order. The chat
// page hydrates with this on mount; the agent loop then continues via
// /api/agent/invoke with the conversation_id.
//
// PATCH /api/agent/conversations/[id]
//
// Updates pin/archive state or title. The chat list relies on these.

const PatchSchema = z.object({
  pinned: z.boolean().nullable().optional(),
  archived: z.boolean().nullable().optional(),
  title: z.string().min(1).max(200).nullable().optional(),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: conv, error: convErr } = await supabase
    .from('agent_conversations')
    .select(
      'id, company_id, user_id, intent_id, context_ref, title, pinned, archived, last_message_at, created_at',
    )
    .eq('id', id)
    .maybeSingle()
  if (convErr) return NextResponse.json({ error: convErr.message }, { status: 500 })
  if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

  // Defense in depth alongside RLS — verify caller is a member of the
  // conversation's company AND owns the conversation row. Conversations are
  // user-scoped within a company; one team member should not see another's.
  if (conv.user_id !== user.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', conv.company_id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const { data: messages, error: msgErr } = await supabase
    .from('agent_messages')
    .select('id, role, content, tool_use_id, hidden, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 })

  return NextResponse.json({ data: { conversation: conv, messages: messages ?? [] } })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  let body: z.infer<typeof PatchSchema>
  try {
    body = PatchSchema.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const update: Record<string, unknown> = {}
  if (body.pinned != null) update.pinned = body.pinned
  if (body.archived != null) update.archived = body.archived
  if (body.title != null) update.title = body.title
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // Defense in depth — verify ownership before update so a 404 is returned
  // (instead of relying solely on RLS, which would silently 0-row).
  const { data: existing } = await supabase
    .from('agent_conversations')
    .select('user_id, company_id')
    .eq('id', id)
    .maybeSingle()
  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('agent_conversations')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('company_id', existing.company_id)
    .select('id, intent_id, context_ref, title, pinned, archived, last_message_at, created_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}
