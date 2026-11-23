import { redirect } from 'next/navigation'
import { legacyKnowledgeHref } from '@/lib/agent-context/wiki-views'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { getDashboardCompanyId } from '../request-context'

/**
 * "Vad din agent vet" became the wiki (decided 2026-10-29). Old links and
 * bookmarks keep working: each view lands on its wiki view, and the page
 * itself on the context view where the wiki now starts. For a company with
 * the agent picture on (AGENT_PICTURE_COMPANY_IDS) each view lands where it
 * is there: a row of the picture, or Bokföringsregler for the profile.
 */
export default async function AgentKnowledgeRedirect({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams
  const picture = isAgentPictureEnabled(await getDashboardCompanyId())
  redirect(legacyKnowledgeHref(Array.isArray(view) ? view[0] : view, { picture }))
}
