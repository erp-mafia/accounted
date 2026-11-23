import { Suspense } from 'react'
import { notFound, redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { pictureRowHref } from '@/lib/agent-context/wiki-views'
import { SkillsPage } from '@/components/skills/SkillsPage'

/**
 * /skills: Agentinstruktioner, hidden in production while it is finished. The kind switch reads ?typ=, hence Suspense.
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) the address leads to the picture with its Kunskap
 * row open, whatever the Agenter page's own switch says: the knowledge is listed there, as folders that open in place.
 */
export default async function Page() {
  const companyId = await getDashboardCompanyId()
  if (isAgentPictureEnabled(companyId)) redirect(pictureRowHref('knowledge'))
  if (!isAgentsPageEnabled(companyId)) notFound()
  return <Suspense><SkillsPage /></Suspense>
}
