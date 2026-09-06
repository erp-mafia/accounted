import { redirect } from 'next/navigation'
import ChatIntakeStarter from '@/components/agent/ChatIntakeStarter'
import { getAiStatus } from '@/lib/ai'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'

export const dynamic = 'force-dynamic'

// /chat/intake: Phase C bootstrap surface. ReviewCard navigates here after
// Phase B "kör" succeeds. The client component mounts AgentChat with
// intent='onboarding.intake' in fresh-start mode; AgentChat auto-fires the
// first invoke which creates the conversation row, and we swap the URL to
// /chat/[id] when the new id streams back.
//
// Plan ref: dev_docs/specialized-agent-plan.md §7 Phase C.
export default async function ChatIntakePage() {
  const [{ user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!user) redirect('/login')
  if (!companyId) redirect('/onboarding')
  // onboarding.intake runs on the tool-loop runtime; without it (#2204) the
  // starter would fire an invoke that answers 503. The agent is built by now,
  // so the general-help console on /chat is the working next step.
  if (!getAiStatus().assistantAvailable) redirect('/chat')

  return <ChatIntakeStarter />
}
