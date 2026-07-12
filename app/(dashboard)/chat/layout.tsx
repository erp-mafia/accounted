import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import ChatSidebar from '@/components/agent/ChatSidebar'

export const dynamic = 'force-dynamic'

// Two-pane chat layout: sidebar with conversations on the left, active
// conversation (or empty state) in the main panel. Both /chat and /chat/[id]
// share this layout so the sidebar doesn't unmount on conversation switches.
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  // Block the chat surface until the agent is built. Without this a user
  // who deep-links to /chat (bookmark, ⌘K, "+ Ny" elsewhere) lands on an
  // empty conversations list with no Anna to talk to. The home route at /
  // renders NewUserChecklist for the same state, so we forward there
  // instead of duplicating the welcome screen here.
  let { data: agent } = await supabase
    .from('agent_profiles')
    .select('verified_at')
    .eq('company_id', companyId)
    .maybeSingle()

  // Sandbox sessions get a pre-built assistant: backfill if a pre-seed
  // session is missing it so /chat doesn't bounce back to / in a loop.
  if (!agent?.verified_at) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('is_sandbox')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settings?.is_sandbox) {
      await ensureSandboxAgentProfile(supabase, companyId)
      const refresh = await supabase
        .from('agent_profiles')
        .select('verified_at')
        .eq('company_id', companyId)
        .maybeSingle()
      agent = refresh.data
    }
  }

  if (!agent?.verified_at) redirect('/')

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
    // the bottom nav (h-16 = 64px) + safe-area-inset-bottom so the chat
    // pane fills the visible viewport exactly. Desktop: full viewport.
    <div className="flex h-[calc(100dvh-4rem-env(safe-area-inset-bottom,0px))] md:h-screen">
      <ChatSidebar initialConversations={conversations ?? []} />
      <div className="flex-1 min-w-0 flex flex-col bg-background">{children}</div>
    </div>
  )
}
