'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { SettingsRow, SettingsRowEnd } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'

interface NavGateToggleProps {
  /** The company_settings flag the switch writes. */
  setting: 'mileage_enabled' | 'sales_orders_enabled'
  /** Message namespace with settings_heading, settings_toggle_help, settings_toggle_label, settings_open_page, settings_save_failed_title. */
  namespace: 'mileage' | 'sales_orders'
  /** The page the feature lives on, linked while it is on. */
  href: string
}

/**
 * A company-level switch that shows or hides a feature's nav row (Körjournal,
 * Kundorder). The flag gates visibility only, never correctness: records
 * created through the API or MCP work regardless and the pages stay
 * reachable by URL, so turning it off never hides existing data.
 */
export function NavGateToggle({ setting, namespace, href }: NavGateToggleProps) {
  const t = useTranslations(namespace)
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const saveSettings = useSaveSettings()
  const [isSaving, setIsSaving] = useState(false)

  const enabled = settings?.[setting] ?? false
  const inputId = `${setting.replace(/_/g, '-')}`

  async function handleChange(next: boolean) {
    setIsSaving(true)
    const saved = await saveSettings(
      { [setting]: next },
      { failedTitle: t('settings_save_failed_title'), refreshNav: true },
    )
    if (saved) updateSettings({ [setting]: next })
    setIsSaving(false)
  }

  const locked = isSaving || !canWrite

  return (
    <SettingsRow label={t('settings_heading')} help={t('settings_toggle_help')}>
      <Switch
        id={inputId}
        checked={enabled}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={locked}
      />
      <label htmlFor={inputId} className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}>
        {t('settings_toggle_label')}
      </label>
      {enabled && (
        <SettingsRowEnd>
          <Link
            href={href}
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
