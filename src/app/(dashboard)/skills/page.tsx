import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { SkillsPage } from '@/components/skills/SkillsPage'

/** /skills: Agentinstruktioner, hidden in production while it is finished. The kind switch reads ?typ=, hence Suspense. */
export default async function Page() {
  const companyId = await getDashboardCompanyId()
  if (!isAgentsPageEnabled(companyId)) notFound()
  return <Suspense><SkillsPage /></Suspense>
}
