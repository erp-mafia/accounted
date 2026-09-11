import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AgentKnowledgeViews } from '@/components/agent-knowledge/AgentKnowledgeViews'

/**
 * "Vad din agent vet" as a page of its own: Kunskap (the konteringskarta and
 * the rules and profile the assistant works from), Minne (what it remembers,
 * editable) and Kompetens (what it ships with), one segmented control. It
 * used to redirect into the settings hub, which in shell v2 opens as a modal
 * over the page you were on; a sidebar item that opens a modal reads as a
 * mistake, and the map wants the whole panel.
 */
export default async function AgentKnowledgePage() {
  const t = await getTranslations('agentKnowledge')
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('description')}</HelpPopover>} />
      <AgentKnowledgeViews />
    </>
  )
}
