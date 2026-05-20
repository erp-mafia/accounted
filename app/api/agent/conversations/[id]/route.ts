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

  const { data, error } = await supabase
    .from('agent_conversations')
    .update(update)
    .eq('id', id)
    .select('id, intent_id, context_ref, title, pinned, archived, last_message_at, created_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ data })
}
