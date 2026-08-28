'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowNote } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * Company-level consent toggle for data analysis (#1346). Persists
 * company_settings.data_analysis_opt_in through the standard settings PUT.
 * The flag is enforced server-side (lib/company/data-analysis.ts) on every
 * path that reads bookkeeping outcomes across companies; this component only
 * mirrors it and states plainly what is analysed. Off by default.
 */
export function DataAnalysisToggle() {
  const t = useTranslations('data_analysis')
  const errorLocale = useLocale() as ErrorLocale
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  const enabled = settings?.data_analysis_opt_in ?? false

  async function handleChange(next: boolean) {
    setIsSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_analysis_opt_in: next }),
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
      updateSettings({ data_analysis_opt_in: next })
    } catch (err) {
      // A rejected fetch never reaches the !res.ok arm above, and the switch
      // is controlled by the settings context, so it stays where it was:
      // without this toast the click looks like a dead control.
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
        id="data-analysis-opt-in"
        checked={enabled}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={locked}
      />
      <label
        htmlFor="data-analysis-opt-in"
        className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}
      >
        {t('settings_toggle_label')}
      </label>
      <SettingsRowNote className="basis-full">
        {t('settings_disclosure')}{' '}
        <Link
          href="/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 transition-colors hover:text-foreground"
        >
          {t('settings_privacy_link')}
        </Link>
      </SettingsRowNote>
    </SettingsRow>
  )
}
