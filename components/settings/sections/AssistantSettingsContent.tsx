'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'

// "Assistenten": the ledger profile the agent reads before booking (Kunskap =
// "Vad din agent vet", opens on the konteringskarta and is the default view),
// what the assistant remembers about this company (Minne, editable), and the
// domain knowledge it ships with (Kompetens, read-only). Tabs keep all three
// one click away instead of stacked.
type View = 'knowledge' | 'memory' | 'skills'

const VIEW_ROUTE: Record<View, string> = {
  knowledge: '/settings/assistant',
  memory: '/settings/assistant?view=memory',
  skills: '/settings/assistant?view=skills',
}

export function AssistantSettingsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const raw = searchParams.get('view')
  const view: View = raw === 'skills' ? 'skills' : raw === 'memory' ? 'memory' : 'knowledge'

  function setView(next: string) {
    // 'knowledge' is the default: keep its URL clean (no query string).
    router.replace(VIEW_ROUTE[next as View] ?? VIEW_ROUTE.knowledge, { scroll: false })
  }

  return (
    <div className="space-y-8">
      <Tabs value={view} onValueChange={setView} className="space-y-6">
        <TabsList>
          <TabsTrigger value="knowledge">Kunskap</TabsTrigger>
          <TabsTrigger value="memory">Minne</TabsTrigger>
          <TabsTrigger value="skills">Kompetens</TabsTrigger>
        </TabsList>

        {/* Radix unmounts the inactive panel, so each panel's data is fetched
            lazily the first time its tab is opened. */}
        <TabsContent value="knowledge">
          <AgentKnowledgePanel />
        </TabsContent>
        <TabsContent value="memory">
          <AgentMemoryPanel />
        </TabsContent>
        <TabsContent value="skills">
          <AgentSkillsPanel />
        </TabsContent>
      </Tabs>

      <FabVisibilityCard />
    </div>
  )
}

// Per-user toggle for the floating assistant button bottom-right. The value
// lives on user_preferences (server-rendered into the dashboard layout), so
// a successful save triggers router.refresh() to make the button react
// immediately instead of on next navigation.
function FabVisibilityCard() {
  const t = useTranslations('settings_assistant')
  const router = useRouter()
  // null = not yet loaded (switch disabled meanwhile)
  const [hideFab, setHideFab] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/user/preferences')
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setHideFab(Boolean(body?.data?.hide_assistant_fab))
      })
      .catch(() => {
        if (!cancelled) setHideFab(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleToggle(showFab: boolean) {
    const nextHide = !showFab
    const previous = hideFab
    setHideFab(nextHide)
    setSaving(true)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hide_assistant_fab: nextHide }),
      })
      if (!res.ok) throw new Error('save failed')
      router.refresh()
    } catch {
      setHideFab(previous)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6 flex items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('fab_title')}</p>
          <p className="text-sm text-muted-foreground">{t('fab_description')}</p>
        </div>
        <Switch
          checked={hideFab === null ? true : !hideFab}
          onCheckedChange={handleToggle}
          disabled={hideFab === null || saving}
          aria-label={t('fab_title')}
        />
      </CardContent>
    </Card>
  )
}
