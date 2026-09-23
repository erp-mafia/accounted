'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow } from '@/components/settings/SettingsRows'
import { isSelfHosted as readSelfHostedFlag } from '@/lib/env/public-flags'

// Session timeouts are a hosted concern: self-hosted deployments have them
// disabled at the config level, so the toggle would be a no-op there.
const isSelfHosted = readSelfHostedFlag()

/**
 * Per-user opt-in for automatic logout. Off by default: the session then
 * lives as long as the Supabase refresh token. On: the hosted idle/absolute
 * timeouts apply (enforced by the middleware via the signed timeout cookie,
 * which the preferences API resets on change).
 */
export function AutoLogoutToggle() {
  const t = useTranslations('settings_security')
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isSelfHosted) return
    let active = true
    ;(async () => {
      try {
        const res = await fetch('/api/user/preferences', { cache: 'no-store' })
        if (!res.ok) return
        const payload = (await res.json()) as {
          data?: { auto_logout?: boolean }
        }
        if (active) setEnabled(payload.data?.auto_logout === true)
      } catch {
        // Leave the default (off); a failed read must not block the page.
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  if (isSelfHosted) return null

  async function handleChange(next: boolean) {
    setEnabled(next)
    setSaving(true)
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_logout: next }),
      })
      if (!res.ok) throw new Error('Could not save')
      toast({
        title: next
          ? t('auto_logout_enabled_toast')
          : t('auto_logout_disabled_toast'),
      })
    } catch {
      setEnabled(!next)
      toast({ title: t('auto_logout_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow
      label={t('auto_logout_label')}
      help={t('auto_logout_description')}
    >
      <Switch
        id="auto-logout"
        checked={enabled}
        onCheckedChange={(value) => void handleChange(value)}
        disabled={loading || saving}
      />
      <label htmlFor="auto-logout" className="cursor-pointer text-sm">
        {t('auto_logout_switch_label')}
      </label>
    </SettingsRow>
  )
}
