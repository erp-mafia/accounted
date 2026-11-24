import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { wikiCompany } from '@/lib/agent-context/wiki-company'
import { pictureRowHref, wikiDestination } from '@/lib/agent-context/wiki-views'
import { SkillsPage } from '@/components/skills/SkillsPage'

/**
 * /skills: Agentinstruktioner, hidden in production while it is finished. The kind switch reads ?typ=, hence Suspense.
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) the address leads to the picture with its Kunskap
 * row open, whatever the Agenter page's own switch says: the knowledge is listed there, as folders that open in place.
 * The forward names where that address ends (wikiDestination), so it is one step also where /wiki itself would lead on.
 */
export default async function Page() {
  const companyId = await getDashboardCompanyId()
  const company = wikiCompany(companyId)
  if (company.picture) redirect(wikiDestination(pictureRowHref('knowledge'), company))
  if (!isAgentsPageEnabled(companyId)) notFound()
  return <Suspense><SkillsPage /></Suspense>
}
