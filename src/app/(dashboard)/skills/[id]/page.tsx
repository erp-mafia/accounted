import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { InstructionDetail } from '@/components/skills/InstructionDetail'

/**
 * /skills/[id]: one agent instruction's page (a flow id, own-<uuid>, kunskap.<pack> or community.<slug>). Hidden in production with /skills.
 * A knowledge item's page (kunskap.<pack>) is also open for a company with the agent picture on: the picture's Kunskap list opens it.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  const { id } = await params
  const segment = decodeURIComponent(id)
  if (!isAgentsPageEnabled(companyId) && !(isAgentPictureEnabled(companyId) && segment.startsWith('kunskap.'))) notFound()
  // Community items and author pages wait for the community launch.
  if (!COMMUNITY_OPEN && (segment.startsWith('community.') || segment.startsWith('av.'))) notFound()
  return <InstructionDetail segment={id} />
}
