'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsRows'
import { createClient } from '@/lib/supabase/client'

/**
 * Per-user opt-in for the daily "nytt att bokfora" email digest
 * (notification_settings.email_digest_enabled, default false; consumed by
 * the bookkeeping-digest cron). Lives on the core account tab: the
 * push-notifications extension has its own settings panel with the same
 * toggle, but that extension is not enabled on hosted, so this is the
 * reachable switch.
 */
export function EmailDigestToggle() {
  const t = useTranslations('settings')
  const { toast } = useToast()
  const supabase = createClient()
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const { data } = await supabase
          .from('notification_settings')
          .select('email_digest_enabled')
          .eq('user_id', user.id)
          .maybeSingle()
        if (active) setEnabled(data?.email_digest_enabled === true)
      } catch (err) {
        // Leave the default (off); a failed read must not block the page.
        console.error('Could not read email digest setting:', err)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleChange(next: boolean) {
    setEnabled(next)
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not signed in')
      // Upsert on user_id: most users have no notification_settings row
      // until they touch a notification preference for the first time.
      const { error } = await supabase
        .from('notification_settings')
        .upsert(
          { user_id: user.id, email_digest_enabled: next },
          { onConflict: 'user_id' },
        )
      if (error) throw new Error(error.message)
      toast({
        title: next
          ? t('digest_enabled_toast')
          : t('digest_disabled_toast'),
      })
    } catch (err) {
      console.error('Could not save email digest setting:', err)
      setEnabled(!next)
      toast({ title: t('digest_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsGroup label={t('digest_group')}>
      <SettingsRow label={t('digest_label')} help={t('digest_description')}>
        <Switch
          id="email-digest"
          checked={enabled}
          onCheckedChange={(value) => void handleChange(value)}
          disabled={loading || saving}
        />
        <label htmlFor="email-digest" className="cursor-pointer text-sm">
          {t('digest_switch_label')}
        </label>
      </SettingsRow>
    </SettingsGroup>
  )
}
