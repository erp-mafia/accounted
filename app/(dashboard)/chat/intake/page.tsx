import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import ChatIntakeStarter from '@/components/agent/ChatIntakeStarter'

export const dynamic = 'force-dynamic'

// /chat/intake: Phase C bootstrap surface. ReviewCard navigates here after
// Phase B "kör" succeeds. The client component mounts AgentChat with
// intent='onboarding.intake' in fresh-start mode; AgentChat auto-fires the
// first invoke which creates the conversation row, and we swap the URL to
// /chat/[id] when the new id streams back.
//
// Plan ref: dev_docs/specialized-agent-plan.md §7 Phase C.
export default async function ChatIntakePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  return <ChatIntakeStarter />
}
