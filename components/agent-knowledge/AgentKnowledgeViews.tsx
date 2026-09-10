'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from './AgentKnowledgePanel'

/**
 * The three views of "Vad din agent vet" on one page: Kunskap (the ledger
 * profile and konteringskarta, the default), Minne (what the assistant
 * remembers about this company, editable) and Kompetens (the domain
 * knowledge it ships with). One segmented control, the view in the URL, so
 * a link from the chat lands on the right one. The settings hub keeps its
 * own copy of the same views for people who arrive through settings.
 */
export type KnowledgeView = 'knowledge' | 'memory' | 'skills'

export function knowledgeViewHref(view: KnowledgeView): string {
  return view === 'knowledge' ? '/agent-knowledge' : `/agent-knowledge?view=${view}`
}

export function AgentKnowledgeViews() {
  const t = useTranslations('agentKnowledge')
  const searchParams = useSearchParams()
  const router = useRouter()
  const raw = searchParams.get('view')
  const view: KnowledgeView = raw === 'skills' ? 'skills' : raw === 'memory' ? 'memory' : 'knowledge'

  return (
    <div className="space-y-6">
      <SegmentedControl
        value={view}
        onChange={(next) => router.replace(knowledgeViewHref(next), { scroll: false })}
        options={[
          { value: 'knowledge', label: t('view_knowledge') },
          { value: 'memory', label: t('view_memory') },
          { value: 'skills', label: t('view_skills') },
        ]}
        aria-label={t('view_label')}
      />
      {/* Only the active view mounts, so each panel fetches the first time
          its view is opened. */}
      {view === 'knowledge' && <AgentKnowledgePanel />}
      {view === 'memory' && <AgentMemoryPanel />}
      {view === 'skills' && <AgentSkillsPanel />}
    </div>
  )
}
