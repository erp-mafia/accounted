'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { SettingsRow } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { syncAppBadge } from '@/lib/pwa/app-badge'
import { mutate } from 'swr'
import {
  applyUiStatePatch,
  isPwaWorklistBadgeEnabled,
  USER_UI_STATE_SWR_KEY,
} from '@/lib/ui-state/client'
import type { UserUiState } from '@/types'

/**
 * Per-user opt-in for the installed PWA Att göra badge. Default off
 * until the key has been stored, so the first enable can ask for
 * notification permission. Lives on Konto next to "Installera som app".
 */
export function PwaWorklistBadgeToggle() {
  const t = useTranslations('settings')
  const { toast } = useToast()
  const { uiState, loaded } = useUiState()
  const storedOn = isPwaWorklistBadgeEnabled(uiState)
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const enabled = optimistic ?? storedOn

  async function handleChange(next: boolean) {
    const previous = enabled
    setOptimistic(next)
    setSaving(true)
    if (!next) void syncAppBadge(0)
    else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    try {
      const res = await applyUiStatePatch({ pwa_worklist_badge: next })
      if (!res.ok) throw new Error('save failed')
    } catch {
      setOptimistic(previous)
      void mutate(
        USER_UI_STATE_SWR_KEY,
        (current: UserUiState | undefined) => ({
          ...(current ?? {}),
          pwa_worklist_badge: previous,
        }),
        { revalidate: false },
      )
      toast({ title: t('pwa_badge_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow label={t('pwa_badge_label')} help={t('pwa_badge_description')}>
      <Switch
        id="pwa-worklist-badge"
        checked={enabled}
        onCheckedChange={(value) => void handleChange(value)}
        disabled={!loaded || saving}
      />
      <label htmlFor="pwa-worklist-badge" className="cursor-pointer text-sm">
        {t('pwa_badge_switch')}
      </label>
    </SettingsRow>
  )
}
