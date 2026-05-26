'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'

// "Assistenten" — what the assistant remembers about this company (Minne,
// editable) and the domain knowledge it ships with (Kompetens, read-only).
// A toggle keeps both one click away instead of stacked, so the competence
// view isn't buried below the memory list.
type View = 'memory' | 'skills'

export default function AssistantSettingsPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const view: View = searchParams.get('view') === 'skills' ? 'skills' : 'memory'

  function setView(next: string) {
    // 'memory' is the default — keep its URL clean (no query string).
    router.replace(next === 'skills' ? '/settings/assistant?view=skills' : '/settings/assistant', {
      scroll: false,
    })
  }

  return (
    <Tabs value={view} onValueChange={setView} className="space-y-6">
      <TabsList>
        <TabsTrigger value="memory">Minne</TabsTrigger>
        <TabsTrigger value="skills">Kompetens</TabsTrigger>
      </TabsList>

      {/* Radix unmounts the inactive panel, so each panel's data is fetched
          lazily the first time its tab is opened. */}
      <TabsContent value="memory">
        <AgentMemoryPanel />
      </TabsContent>
      <TabsContent value="skills">
        <AgentSkillsPanel />
      </TabsContent>
    </Tabs>
  )
}
