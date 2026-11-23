import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { SkillsPage } from '@/components/skills/SkillsPage'

/**
 * /skills: Agentinstruktioner, hidden in production while it is finished. The kind switch reads ?typ=, hence Suspense.
 * For a company with the agent picture on (AGENT_PICTURE_COMPANY_IDS) the page is the knowledge kind alone, and it is
 * open there whatever the Agenter page's own switch says: the picture's Kunskap list leads to it.
 */
export default async function Page() {
  const companyId = await getDashboardCompanyId()
  const knowledgeOnly = isAgentPictureEnabled(companyId)
  if (!isAgentsPageEnabled(companyId) && !knowledgeOnly) notFound()
  return <Suspense><SkillsPage knowledgeOnly={knowledgeOnly} /></Suspense>
}
