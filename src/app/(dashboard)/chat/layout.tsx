import { redirect } from 'next/navigation'
import ChatSidebar from '@/components/agent/ChatSidebar'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getResolvedDashboardAgentProfile,
} from '../request-context'

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

  // Until the agent is built, the Assistent entry leads to building it
  // (crm#1135): the build ends in /chat/intake, and the build page itself
  // sends a company without the ai capability to billing. Forwarding to Hem
  // instead left a new account with no visible way to the assistant at all.
  if (!agent?.verified_at) redirect('/onboarding/agent')

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
      <ChatSidebar initialConversations={conversations ?? []} />
      <div className="flex-1 min-w-0 flex flex-col bg-background">{children}</div>
    </div>
  )
}
