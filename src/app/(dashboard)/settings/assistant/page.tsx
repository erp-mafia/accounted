import { redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { pictureHrefOfView } from '@/lib/agent-context/wiki-views'

/**
 * The old "Assistenten" settings page. Its panels are views of the wiki
 * (Bokföringsprofil, Minne) and its one switch, the floating assistant
 * button, is a row of Ditt konto, so the route only forwards old links
 * (product decision 2026-11-16). Byrå scope (?ctx=byra) forwards the same
 * way: the panels always showed the active company, never the byrå.
 *
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) each
 * link forwards to where that view is there (pictureHrefOfView): a row of
 * the picture, or Bokföringsregler for the profile.
 */
export default async function AssistantSettingsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const raw = (await searchParams).view
  const view = Array.isArray(raw) ? raw[0] : raw
  const companyId = await getDashboardCompanyId()
  if (isAgentPictureEnabled(companyId)) redirect(pictureHrefOfView(view === 'memory' ? 'memory' : view === 'skills' ? 'skills' : 'map'))
  if (view === 'memory') redirect('/wiki?view=memory')
  if (view === 'skills') redirect(isAgentsPageEnabled(companyId) ? '/skills' : '/wiki?view=skills')
  redirect('/wiki?view=map')
}
