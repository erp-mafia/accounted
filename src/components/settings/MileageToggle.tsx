'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsRow,
  SettingsRowEnd,
} from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * Company-level toggle for the Körjournal (mileage log). Persists
 * company_settings.mileage_enabled through the standard settings PUT: the
 * flag gates UI visibility only (the nav row), never correctness. Trips
 * created via API/MCP work regardless, and the nav row also shows whenever
 * mileage_trips rows exist (hybrid gate computed by the dashboard layout),
 * so turning this off never hides existing underlag.
 */
export function MileageToggle() {
  const t = useTranslations('mileage')
  const errorLocale = useLocale() as ErrorLocale
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  const enabled = settings?.mileage_enabled ?? false

  async function handleChange(next: boolean) {
    setIsSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mileage_enabled: next }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('settings_save_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      updateSettings({ mileage_enabled: next })
    } catch (err) {
      // A rejected fetch (offline, DNS failure, aborted request) never reaches
      // the !res.ok arm above, and the switch is controlled by the settings
      // context, so it simply stays where it was: without this toast the click
      // looks like a dead control rather than a save that did not happen.
      toast({
        title: t('settings_save_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  const locked = isSaving || !canWrite

  return (
    <SettingsRow label={t('settings_heading')} help={t('settings_toggle_help')}>
      <Switch
        id="mileage-enabled"
        checked={enabled}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={locked}
      />
      <label
        htmlFor="mileage-enabled"
        className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}
      >
        {t('settings_toggle_label')}
      </label>
      {enabled && (
        <SettingsRowEnd>
          <Link
            href="/mileage"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('settings_open_page')}
          </Link>
        </SettingsRowEnd>
      )}
    </SettingsRow>
  )
}
