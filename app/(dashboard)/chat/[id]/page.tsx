import { notFound, redirect } from 'next/navigation'
import ChatConversationView from '@/components/agent/ChatConversationView'
import type { StoredStagedOperation } from '@/types'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

// /chat/[id]: server-renders the conversation row + ordered messages, then
// hydrates the client AgentChat with them so the user can continue typing
// against the existing conversation_id. The agent loop on the server picks
// up via /api/agent/invoke with conversation_id supplied.
export default async function ChatConversationPage({ params }: PageProps) {
  const { id } = await params
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!user) redirect('/login')
  if (!companyId) redirect('/onboarding')

  // Both queries key on the route id, so they run in parallel. The tenant
  // check on the conversation row still gates rendering — when it fails,
  // notFound() throws and the messages result is discarded unrendered.
  const [{ data: conversation }, { data: messages }, staged] = await Promise.all([
    supabase
      .from('agent_conversations')
      .select('id, intent_id, context_ref, title, pinned, archived, last_message_at')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('agent_messages')
      .select('role, content, hidden, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true }),
    // Proposals this thread staged that are still unanswered, so the approval
    // card comes back on resume rather than the proposal quietly waiting out
    // its expiry in Granskning with nothing here pointing at it.
    supabase
      .from('pending_operations')
      .select('id, operation_type, title, risk_level, preview_data, params, created_at')
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .eq('agent_metadata->>conversation_id', id)
      .order('created_at', { ascending: true }),
  ])

  if (!conversation) notFound()
  // An empty list here would silently hide still-open proposals, which is the
  // failure this query exists to prevent: fail loudly instead of quietly
  // rendering a thread that looks like it never staged anything.
  if (staged.error) throw staged.error

  return (
    <ChatConversationView
      conversationId={id}
      intentId={conversation.intent_id}
      contextRef={conversation.context_ref}
      title={conversation.title ?? intentLabel(conversation.intent_id)}
      rawMessages={(messages ?? []) as { role: string; content: unknown; hidden?: boolean }[]}
      stagedOperations={(staged.data ?? []) as StoredStagedOperation[]}
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
