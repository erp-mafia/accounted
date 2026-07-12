import { redirect } from 'next/navigation'

// "Vad din agent vet" moved into Settings (Assistenten -> Kunskap). This
// route is kept as a permanent redirect so old links/bookmarks still resolve.
export default function AgentKnowledgeRedirect() {
  redirect('/settings/assistant?view=knowledge')
}
