import { notFound } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentsPageEnabled } from '@/lib/agent-skills/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { InstructionDetail } from '@/components/skills/InstructionDetail'
import { KnowledgeItemPage } from '@/components/skills/KnowledgeItemPage'

/**
 * /skills/[id]: one agent instruction's page (a flow id, own-<uuid>, kunskap.<pack> or community.<slug>). Hidden in production with /skills.
 * For a company with the agent picture on, a knowledge item's page (kunskap.<pack>) is open whatever the Agenter page's own switch
 * says, and it is the item alone: what the picture's Kunskap panel shows for an opened folder, under a trail back to the picture.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  const { id } = await params
  const segment = decodeURIComponent(id)
  const pictureItem = isAgentPictureEnabled(companyId) && segment.startsWith('kunskap.')
  if (!isAgentsPageEnabled(companyId) && !pictureItem) notFound()
  if (pictureItem) return <KnowledgeItemPage segment={id} />
  // Community items and author pages wait for the community launch.
  if (!COMMUNITY_OPEN && (segment.startsWith('community.') || segment.startsWith('av.'))) notFound()
  return <InstructionDetail segment={id} />
}
