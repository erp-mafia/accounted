'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { SettingsRow } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'

/**
 * The company's say over one click (company_settings.direct_booking_enabled,
 * accounted#130). On, a bank row's or the Inkorg's suggestion that the
 * direct-booking policy calls settled books from its Bokför, with Ångra on
 * the toast. Off, every suggestion opens its review first. Saved through the
 * standard settings PUT (owner or admin), audited like every setting.
 */
export function DirectBookingToggle() {
  const t = useTranslations('settings_bookkeeping')
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const saveSettings = useSaveSettings()
  const [isSaving, setIsSaving] = useState(false)

  // The column defaults to on; a row read before the migration has no key.
  const enabled = settings?.direct_booking_enabled !== false

  async function handleChange(next: boolean) {
    setIsSaving(true)
    const saved = await saveSettings({ direct_booking_enabled: next }, { failedTitle: t('direct_booking_save_failed') })
    if (saved) updateSettings({ direct_booking_enabled: next })
    setIsSaving(false)
  }

  const locked = isSaving || !canWrite

  return (
    <SettingsRow label={t('direct_booking_label')} help={t('direct_booking_help')}>
      <Switch id="direct-booking-enabled" checked={enabled} onCheckedChange={(next) => void handleChange(next)} disabled={locked} />
      <label htmlFor="direct-booking-enabled" className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}>
        {enabled ? t('direct_booking_on') : t('direct_booking_off')}
      </label>
    </SettingsRow>
  )
}
