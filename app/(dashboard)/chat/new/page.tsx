import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getActiveCompanyId } from '@/lib/company/context'
import ChatNewStarter from '@/components/agent/ChatNewStarter'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ intent?: string; prompt?: string }>
}

// /chat/new — generic conversation bootstrap. Reads ?intent= and ?prompt=
// from the URL and mounts AgentChat in fresh mode; AgentChat creates the
// conversation server-side on first invoke and the client swaps the URL
// to /chat/[id] when the id streams back. Mirrors /chat/intake but with
// caller-chosen intent/seed, so suggestion chips and ⌘K can route here
// inline instead of opening the slide-in sheet.
export default async function ChatNewPage({ searchParams }: PageProps) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const sp = await searchParams
  const intent = typeof sp.intent === 'string' && sp.intent.trim() ? sp.intent.trim() : 'general.help'
  const prompt = typeof sp.prompt === 'string' ? sp.prompt : ''

  return <ChatNewStarter intentId={intent} seedUserMessage={prompt} />
}
