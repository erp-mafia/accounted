import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AgentKnowledgeViews } from '@/components/agent-knowledge/AgentKnowledgeViews'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { getDashboardCompanyId } from '../request-context'

/**
 * "Vad din agent vet" as a page of its own: Kunskap (the konteringskarta and
 * the rules and profile the assistant works from), Minne (what it remembers,
 * editable) and Kompetens (what it ships with), one segmented control. It
 * used to redirect into the settings hub, which opens as a modal
 * over the page you were on; a sidebar item that opens a modal reads as a
 * mistake, and the map wants the whole panel.
 *
 * Fakta (what Arkiv has read out of the company's documents) exists only
 * inside the Arkiv rollout. Outside it nothing reads the documents, so the
 * view is not offered: its empty state used to promise facts after an upload
 * that would never produce any.
 */
export default async function AgentKnowledgePage() {
  const t = await getTranslations('agentKnowledge')
  const companyId = await getDashboardCompanyId()
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('description')}</HelpPopover>} />
      <AgentKnowledgeViews facts={!!companyId && isArkivBrainEnabled(companyId)} />
    </>
  )
}
