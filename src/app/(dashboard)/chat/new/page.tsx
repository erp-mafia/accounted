import { redirect } from 'next/navigation'
import ChatNewStarter from '@/components/agent/ChatNewStarter'
import { getIntent } from '@/lib/agent/intents/registry'
import { CHAT_INTENT_ID } from '@/lib/agent/ask/persist'
import { getAiStatus } from '@/lib/ai'
import { getDashboardAuthContext, getDashboardCompanyId } from '../../request-context'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ intent?: string; prompt?: string }>
}

// /chat/new: generic conversation bootstrap. Reads ?intent= and ?prompt=
// from the URL and mounts AgentChat in fresh mode; AgentChat creates the
// conversation server-side on first invoke and the client swaps the URL
// to /chat/[id] when the id streams back. Mirrors /chat/intake but with
// caller-chosen intent/seed, so suggestion chips and ⌘K can route here
// inline instead of opening the slide-in sheet.
export default async function ChatNewPage({ searchParams }: PageProps) {
  const [{ user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])
  if (!user) redirect('/login')
  if (!companyId) redirect('/onboarding')

  const sp = await searchParams
  const requested = typeof sp.intent === 'string' && sp.intent.trim() ? sp.intent.trim() : 'general.help'
  // Validate against the registry: a bogus ?intent= would otherwise render the
  // chat shell and then fail at invoke with a 400, which reads as "Anna is broken"
  // rather than "bad link". Fall back to general help instead.
  // Specialized intents run on the tool-loop runtime; where the deployment
  // cannot run it (#2204) the single-call console takes the same prompt as
  // general help instead of a chat that fails at invoke.
  const intent =
    getIntent(requested) && (requested === CHAT_INTENT_ID || getAiStatus().assistantAvailable)
      ? requested
      : CHAT_INTENT_ID
  const prompt = typeof sp.prompt === 'string' ? sp.prompt : ''

  return <ChatNewStarter intentId={intent} seedUserMessage={prompt} />
}
