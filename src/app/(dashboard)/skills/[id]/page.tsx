import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { InstructionDetail } from '@/components/skills/InstructionDetail'

/** /skills/[id]: one agent instruction's page (a flow id, own-<uuid>, regler.<pack> or community.<slug>). Hidden in production with /skills. */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  if (!isAgentsPageEnabled(companyId)) notFound()
  const { id } = await params
  // Community items and author pages wait for the community launch.
  const segment = decodeURIComponent(id)
  if (!COMMUNITY_OPEN && (segment.startsWith('community.') || segment.startsWith('av.'))) notFound()
  return <InstructionDetail segment={id} />
}
