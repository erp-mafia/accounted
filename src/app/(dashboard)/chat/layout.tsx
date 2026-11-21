import { redirect } from 'next/navigation'
import ChatSidebar from '@/components/agent/ChatSidebar'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getResolvedDashboardAgentProfile,
} from '../request-context'
import { CONNECT_AGENT_HREF, chatSwitchedOnFor } from './chat-switch'

export const dynamic = 'force-dynamic'

// Two-pane chat layout: sidebar with conversations on the left, active
// conversation (or empty state) in the main panel. Both /chat and /chat/[id]
// share this layout so the sidebar doesn't unmount on conversation switches.
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const [{ supabase, user }, companyId, agent] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
    getResolvedDashboardAgentProfile(),
  ])
  if (!user) redirect('/login')
  if (!companyId) redirect('/onboarding')

  // The built-in assistant switched off for the company
  // (ASSISTANT_CHAT_ENABLED): /chat shows what took its place and every other
  // chat page leads there, built agent or not, and the conversation list is
  // never read.
  if (!chatSwitchedOnFor(companyId)) return <>{children}</>

  // The chat is for a company whose assistant was built (agent_profiles
  // .verified_at). The build is removed, so a company without one has no chat
  // to open: it is led to Koppla en agent, where its own assistant connects.
  // Forwarding to Hem instead left a new account with no visible way to an
  // assistant at all (crm#1135).
  if (!agent?.verified_at) redirect(CONNECT_AGENT_HREF)

  const { data: conversations } = await supabase
    .from('agent_conversations')
    .select(
      'id, intent_id, context_ref, title, pinned, archived, last_message_at, last_message_preview, created_at',
    )
    .eq('company_id', companyId)
    .eq('archived', false)
    .order('pinned', { ascending: false })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(100)

  return (
    // MainContainer hands /chat a full-bleed h-full wrapper, so we don't
    // need negative margins to break out of any chrome padding.
    //
    // dvh handles mobile browser chrome shrinking on scroll. Mobile: subtract
    // the bottom nav (--bottom-nav-h, globals.css) so the chat pane fills the
    // visible viewport exactly. Desktop: fill the frame panel (<main> has an
    // explicit height there, so h-full resolves).
    <div className="flex h-[calc(100dvh-var(--bottom-nav-h))] md:h-full">
      <ChatSidebar initialConversations={conversations ?? []} renderedAt={new Date().getTime()} />
      <div className="flex-1 min-w-0 flex flex-col bg-background">{children}</div>
    </div>
  )
}
