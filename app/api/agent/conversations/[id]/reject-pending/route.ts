import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { rejectPendingForConversation } from '@/lib/agent/pending/reject-conversation-pending'

// POST /api/agent/conversations/[id]/reject-pending
//
// Rejects every still-pending proposal the assistant staged in this
// conversation — the chat's "clear the proposals I didn't approve" action, so
// users don't have to reject leftovers one by one in Granskning.

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

export const POST = withRouteContext(
  'agent.conversations.reject_pending',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, user } = ctx

    // Conversations are user-scoped: prove ownership before touching its rows.
    const { data: conv } = await supabase
      .from('agent_conversations')
      .select('id, company_id, user_id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!conv) return notFound()

    // Defense in depth alongside RLS: still a member of the conversation's company.
    const { data: membership } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', conv.company_id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return notFound()

    const cleared = await rejectPendingForConversation(supabase, conv.company_id as string, id)
    return NextResponse.json({ data: { cleared } })
  },
)
