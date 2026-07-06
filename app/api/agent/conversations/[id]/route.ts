import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

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

const notFound = () =>
  NextResponse.json(
    {
      error: {
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Konversationen hittades inte.',
        message_en: 'Conversation not found.',
      },
    },
    { status: 404 },
  )

export const GET = withRouteContext(
  'agent.conversations.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, user } = ctx

    // Conversations are user-scoped: fetched by ownership rather than the
    // active company, so a user can open their own conversations in any
    // company they belong to.
    const { data: conv, error: convErr } = await supabase
      .from('agent_conversations')
      .select(
        'id, company_id, user_id, intent_id, context_ref, title, pinned, archived, last_message_at, created_at',
      )
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (convErr) throw convErr
    if (!conv) return notFound()

    // Defense in depth alongside RLS: the caller must still be a member of
    // the conversation's company (they may have been removed since).
    const { data: membership } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', conv.company_id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return notFound()

    const { data: messages, error: msgErr } = await supabase
      .from('agent_messages')
      .select('id, role, content, tool_use_id, hidden, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
    if (msgErr) throw msgErr

    return NextResponse.json({ data: { conversation: conv, messages: messages ?? [] } })
  },
)

export const PATCH = withRouteContext(
  'agent.conversations.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, user, log } = ctx

    const validation = await validateBody(request, PatchSchema, {
      log,
      operation: 'agent.conversations.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const update: Record<string, unknown> = {}
    if (body.pinned != null) update.pinned = body.pinned
    if (body.archived != null) update.archived = body.archived
    if (body.title != null) update.title = body.title
    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        {
          error: {
            code: 'NOTHING_TO_UPDATE',
            message: 'Inget att uppdatera.',
            message_en: 'Nothing to update.',
          },
        },
        { status: 400 },
      )
    }

    // Defense in depth: verify ownership before update so a 404 is returned
    // (instead of relying solely on RLS, which would silently 0-row).
    const { data: existing } = await supabase
      .from('agent_conversations')
      .select('user_id, company_id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!existing) return notFound()

    const { data, error } = await supabase
      .from('agent_conversations')
      .update(update)
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('company_id', existing.company_id)
      .select('id, intent_id, context_ref, title, pinned, archived, last_message_at, created_at')
      .single()
    if (error) throw error
    return NextResponse.json({ data })
  },
)
