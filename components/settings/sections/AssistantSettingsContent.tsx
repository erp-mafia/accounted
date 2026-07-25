'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AgentKnowledgePanel } from '@/components/agent-knowledge/AgentKnowledgePanel'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsSectionHeader,
  SettingsSeg,
} from '@/components/settings/SettingsRows'

// "Assistenten": the ledger profile the agent reads before booking (Kunskap =
// "Vad din agent vet", opens on the konteringskarta and is the default view),
// what the assistant remembers about this company (Minne, editable), and the
// domain knowledge it ships with (Kompetens, read-only). The segmented control
// keeps all three one click away instead of stacked.
type View = 'knowledge' | 'memory' | 'skills'

const VIEW_ROUTE: Record<View, string> = {
  knowledge: '/settings/assistant',
  memory: '/settings/assistant?view=memory',
  skills: '/settings/assistant?view=skills',
}

const VIEW_OPTIONS: Array<{ value: View; label: string }> = [
  { value: 'knowledge', label: 'Kunskap' },
  { value: 'memory', label: 'Minne' },
  { value: 'skills', label: 'Kompetens' },
]

export function AssistantSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const searchParams = useSearchParams()
  const router = useRouter()
  const raw = searchParams.get('view')
  const view: View = raw === 'skills' ? 'skills' : raw === 'memory' ? 'memory' : 'knowledge'

  function setView(next: View) {
    // 'knowledge' is the default: keep its URL clean (no query string).
    router.replace(VIEW_ROUTE[next] ?? VIEW_ROUTE.knowledge, { scroll: false })
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('assistant')} intro={tIntro('assistant')} />

      <div className="mt-6">
        <SettingsSeg value={view} onChange={setView} options={VIEW_OPTIONS} aria-label="Välj vy" />
      </div>

      {/* Only the active view mounts, so each panel's data is fetched lazily
          the first time its view is opened (same behavior as when Radix Tabs
          unmounted the inactive panels). */}
      <div className="mt-6">
        {view === 'knowledge' && <AgentKnowledgePanel />}
        {view === 'memory' && <AgentMemoryPanel />}
        {view === 'skills' && <AgentSkillsPanel />}
      </div>

      <FabVisibilityRow />
    </div>
  )
}

// Per-user toggle for the floating assistant button bottom-right. The value
// lives on user_preferences (server-rendered into the dashboard layout), so
// a successful save triggers router.refresh() to make the button react
// immediately instead of on next navigation.
function FabVisibilityRow() {
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
    <SettingsGroup>
      <SettingsRow label={t('fab_title')} help={t('fab_description')}>
        <SettingsRowEnd>
          <Switch
            checked={hideFab === null ? true : !hideFab}
            onCheckedChange={handleToggle}
            disabled={hideFab === null || saving}
            aria-label={t('fab_title')}
          />
        </SettingsRowEnd>
      </SettingsRow>
    </SettingsGroup>
  )
}
