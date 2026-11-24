import { redirect } from 'next/navigation'
import { wikiCompany } from '@/lib/agent-context/wiki-company'
import { legacyKnowledgeHref, wikiDestination } from '@/lib/agent-context/wiki-views'
import { getDashboardCompanyId } from '../request-context'

/**
 * "Vad din agent vet" became the wiki (decided 2026-10-29). Old links and
 * bookmarks keep working: each view lands on its wiki view, and the page
 * itself on the context view where the wiki now starts. For a company with
 * the agent picture on (AGENT_PICTURE_COMPANY_IDS) each view lands where it
 * is there: a row of the picture, or Bokföringsregler for the profile.
 * The forward names where that address ends (wikiDestination), so it is one
 * step also where /wiki itself would lead on.
 */
export default async function AgentKnowledgeRedirect({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const { view } = await searchParams
  const company = wikiCompany(await getDashboardCompanyId())
  redirect(wikiDestination(legacyKnowledgeHref(Array.isArray(view) ? view[0] : view, { picture: company.picture }), company))
}
