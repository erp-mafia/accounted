import { redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'

/**
 * The old "Assistenten" settings page. Its panels are views of the wiki
 * (Bokföringsprofil, Minne) and its one switch, the floating assistant
 * button, is a row of Ditt konto, so the route only forwards old links
 * (founder decision 2026-11-16). Byrå scope (?ctx=byra) forwards the same
 * way: the panels always showed the active company, never the byrå.
 */
export default async function AssistantSettingsPage({ searchParams }: { searchParams: Promise<{ view?: string | string[] }> }) {
  const raw = (await searchParams).view
  const view = Array.isArray(raw) ? raw[0] : raw
  if (view === 'memory') redirect('/wiki?view=memory')
  if (view === 'skills') redirect(isAgentsPageEnabled(await getDashboardCompanyId()) ? '/skills' : '/wiki?view=skills')
  redirect('/wiki?view=map')
}
