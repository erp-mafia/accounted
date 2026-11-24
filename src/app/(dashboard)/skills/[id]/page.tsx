import { notFound, redirect } from 'next/navigation'
import { getDashboardCompanyId } from '../../request-context'
import { isAgentItemPageEnabled } from '@/lib/agent-skills/flag'
import { wikiCompany } from '@/lib/agent-context/wiki-company'
import { pictureRowHref, wikiDestination } from '@/lib/agent-context/wiki-views'
import { COMMUNITY_OPEN } from '@/lib/agent-skills/agents'
import { InstructionDetail } from '@/components/skills/InstructionDetail'

/** The address segment of a knowledge item: kunskap.<item>, the item as lib/agent-context/wiki-views.ts spells it. */
const KNOWLEDGE_SEGMENT = 'kunskap.'

/**
 * /skills/[id]: one agent instruction's page (a flow id, own-<uuid>, kunskap.<pack> or community.<slug>). Hidden in production with /skills.
 * For a company with the agent picture on, a knowledge item's address (kunskap.<pack>) leads to the picture with its Kunskap row open on
 * that item's folder, and an own item's pages (ny, own-<uuid>, egen.<uuid>) answer, whatever the Agenter page's own switch says: the
 * picture's Kunskap panel links to them. Every other id answers as it does without the picture (isAgentItemPageEnabled).
 * The forward names where the picture's address ends (wikiDestination), so it is one step also where /wiki itself would lead on.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const companyId = await getDashboardCompanyId()
  const { id } = await params
  const segment = decodeURIComponent(id)
  const company = wikiCompany(companyId)
  if (company.picture && segment.startsWith(KNOWLEDGE_SEGMENT)) redirect(wikiDestination(pictureRowHref('knowledge', segment.slice(KNOWLEDGE_SEGMENT.length)), company))
  if (!isAgentItemPageEnabled(companyId, segment)) notFound()
  // Community items and author pages wait for the community launch.
  if (!COMMUNITY_OPEN && (segment.startsWith('community.') || segment.startsWith('av.'))) notFound()
  return <InstructionDetail segment={id} />
}
