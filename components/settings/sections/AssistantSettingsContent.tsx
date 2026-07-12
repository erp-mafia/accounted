'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'

// "Assistenten": what the assistant remembers about this company (Minne,
// editable), the domain knowledge it ships with (Kompetens, read-only), and
// the ledger profile it reads before booking (Kunskap = "Vad din agent vet",
// read-only). Tabs keep all three one click away instead of stacked.
type View = 'memory' | 'skills' | 'knowledge'

const VIEW_ROUTE: Record<View, string> = {
  memory: '/settings/assistant',
  skills: '/settings/assistant?view=skills',
  knowledge: '/settings/assistant?view=knowledge',
}

export function AssistantSettingsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const raw = searchParams.get('view')
  const view: View = raw === 'skills' ? 'skills' : raw === 'knowledge' ? 'knowledge' : 'memory'

  function setView(next: string) {
    // 'memory' is the default: keep its URL clean (no query string).
    router.replace(VIEW_ROUTE[next as View] ?? VIEW_ROUTE.memory, { scroll: false })
  }

  return (
    <Tabs value={view} onValueChange={setView} className="space-y-6">
      <TabsList>
        <TabsTrigger value="memory">Minne</TabsTrigger>
        <TabsTrigger value="skills">Kompetens</TabsTrigger>
        <TabsTrigger value="knowledge">Kunskap</TabsTrigger>
      </TabsList>

      {/* Radix unmounts the inactive panel, so each panel's data is fetched
          lazily the first time its tab is opened. */}
      <TabsContent value="memory">
        <AgentMemoryPanel />
      </TabsContent>
      <TabsContent value="skills">
        <AgentSkillsPanel />
      </TabsContent>
      <TabsContent value="knowledge">
        <AgentKnowledgePanel />
      </TabsContent>
    </Tabs>
  )
}
