import { redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { wikiCompany } from '@/lib/agent-context/wiki-company'
import { pictureHrefOfView, wikiDestination } from '@/lib/agent-context/wiki-views'

/**
 * The old "Assistenten" settings page. Its panels are views of the wiki
 * (Bokföringsprofil, Minne) and its one switch, the floating assistant
 * button, is a row of Ditt konto, so the route only forwards old links
 * (product decision 2026-11-16). Byrå scope (?ctx=byra) forwards the same
 * way: the panels always showed the active company, never the byrå.
 *
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) each
 * link forwards to where that view is there (pictureHrefOfView): a row of
 * the picture, or Bokföringsregler for the profile. Every forward names
 * where its address ends (wikiDestination), so it is one step also where
 * /wiki itself would lead on.
 */
export default async function AssistantSettingsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const raw = (await searchParams).view
  const view = Array.isArray(raw) ? raw[0] : raw
  const companyId = await getDashboardCompanyId()
  const company = wikiCompany(companyId)
  if (company.picture) redirect(wikiDestination(pictureHrefOfView(view === 'memory' ? 'memory' : view === 'skills' ? 'skills' : 'map'), company))
  if (view === 'memory') redirect(wikiDestination('/wiki?view=memory', company))
  if (view === 'skills') redirect(isAgentsPageEnabled(companyId) ? '/skills' : wikiDestination('/wiki?view=skills', company))
  redirect(wikiDestination('/wiki?view=map', company))
}
