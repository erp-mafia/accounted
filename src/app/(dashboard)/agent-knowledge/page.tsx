import { redirect } from 'next/navigation'
import { legacyKnowledgeHref } from '@/lib/agent-context/wiki-views'

/**
 * "Vad din agent vet" became the wiki (decided 2026-10-29). Old links and
 * bookmarks keep working: each view lands on its wiki view, and the page
 * itself on the context view where the wiki now starts.
 */
export default async function AgentKnowledgeRedirect({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams
  redirect(legacyKnowledgeHref(Array.isArray(view) ? view[0] : view))
}
