import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import ChatConversationView from '@/components/agent/ChatConversationView'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

// /chat/[id] — server-renders the conversation row + ordered messages, then
// hydrates the client AgentChat with them so the user can continue typing
// against the existing conversation_id. The agent loop on the server picks
// up via /api/agent/invoke with conversation_id supplied.
export default async function ChatConversationPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const { data: conversation } = await supabase
    .from('agent_conversations')
    .select('id, intent_id, context_ref, title, pinned, archived, last_message_at')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!conversation) notFound()

  const { data: messages } = await supabase
    .from('agent_messages')
    .select('role, content, hidden, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })

  return (
    <ChatConversationView
      conversationId={id}
      intentId={conversation.intent_id}
      contextRef={conversation.context_ref}
      title={conversation.title ?? intentLabel(conversation.intent_id)}
      rawMessages={(messages ?? []) as { role: string; content: unknown; hidden?: boolean }[]}
    />
  )
}

function intentLabel(intentId: string): string {
  switch (intentId) {
    case 'general.help':
      return 'Fråga din assistent'
    case 'transaction.categorization':
      return 'Hjälp med transaktion'
    case 'invoice.draft':
      return 'Hjälp med faktura'
    case 'supplier_invoice.review':
      return 'Granska leverantörsfaktura'
    default:
      return intentId
  }
}
