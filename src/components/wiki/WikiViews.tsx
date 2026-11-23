'use client'

import { useSearchParams } from 'next/navigation'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'
import { AgentFactsPanel } from '@/components/agent-knowledge/AgentFactsPanel'
import { useClaimNavRow } from '@/components/dashboard/nav-row-claim'
import { PICTURE_ITEM_PARAM, wikiPlace } from '@/lib/agent-context/wiki-views'
import { ContextView } from './ContextView'

/** The page's own address, and the menu row of the picture. */
const WIKI_PATH = '/wiki'

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
 * the picture, and an address that names one of its rows (wikiPlace) shows
 * the picture with that row open.
 */
export function WikiViews({ facts, picture = false }: { facts: boolean; picture?: boolean }) {
  const searchParams = useSearchParams()
  const place = wikiPlace({ view: searchParams.get('view'), item: searchParams.get(PICTURE_ITEM_PARAM) }, { picture, facts })
  const view = place.show === 'view' ? place.view : 'context'
  // The picture is one menu row whichever of its rows the address names.
  useClaimNavRow(WIKI_PATH, place.show === 'picture' ? WIKI_PATH : null)

  return (
    <div className="space-y-6">
      {/* Only the active view mounts, so each one fetches the first time it is opened. */}
      {view === 'context' && <ContextView picture={picture} row={place.show === 'picture' ? place.row : null} item={place.show === 'picture' ? place.item : null} />}
      {view === 'map' && <AgentKnowledgePanel heading={false} />}
      {view === 'facts' && <AgentFactsPanel />}
      {view === 'memory' && <AgentMemoryPanel />}
      {view === 'skills' && <AgentSkillsPanel />}
    </div>
  )
}
