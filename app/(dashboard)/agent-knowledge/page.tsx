import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'

/**
 * "Vad din agent vet" as a page of its own: the konteringskarta, the rules
 * and profile the assistant works from, its competence and what it
 * remembers. It used to redirect into the settings hub, which in shell v2
 * opens as a modal over the page you were on; a sidebar item that opens a
 * modal reads as a mistake, and the map wants the whole panel. Editing
 * (skills, memory) still lives in settings, one link away.
 */
export default async function AgentKnowledgePage() {
  const t = await getTranslations('agentKnowledge')
  return (
    <>
      <PageHeader title={t('title')} help={<HelpPopover>{t('description')}</HelpPopover>} />
      <AgentKnowledgePanel />
    </>
  )
}
