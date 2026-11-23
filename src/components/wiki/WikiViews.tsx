'use client'

import { useSearchParams } from 'next/navigation'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'
import { AgentFactsPanel } from '@/components/agent-knowledge/AgentFactsPanel'
import { parseWikiView } from '@/lib/agent-context/wiki-views'
import { ContextView } from './ContextView'

/**
 * The views of the wiki on one page (lib/agent-context/wiki-views.ts): the
 * view is in the URL, so a link from the chat lands on the right one, and
 * each view is a row of the Agenter menu (nav-v3.ts), so the page carries no
 * switcher of its own. The wiki replaced "Vad din agent vet" (decided 2026-10-29);
 * /agent-knowledge redirects here.
 *
 * `facts`: whether the company is inside the Arkiv rollout, where Fakta has
 * something to show. `picture`: whether the company has the agent picture
 * switched on (lib/env/agent-picture-switch.ts): the context view is then
 * the picture.
 */
export function WikiViews({ facts, picture = false }: { facts: boolean; picture?: boolean }) {
  const searchParams = useSearchParams()
  const parsed = parseWikiView(searchParams.get('view'))
  const view = parsed === 'facts' && !facts ? 'context' : parsed

  return (
    <div className="space-y-6">
      {/* Only the active view mounts, so each one fetches the first time it is opened. */}
      {view === 'context' && <ContextView picture={picture} />}
      {view === 'map' && <AgentKnowledgePanel heading={false} />}
      {view === 'facts' && <AgentFactsPanel />}
      {view === 'memory' && <AgentMemoryPanel />}
      {view === 'skills' && <AgentSkillsPanel />}
    </div>
  )
}
