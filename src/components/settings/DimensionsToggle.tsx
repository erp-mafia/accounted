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
 * Company-level toggle for the dimensions register (kostnadsställen &
 * projekt). Persists company_settings.dimensions_enabled through the standard
 * settings PUT: the flag gates UI visibility only (nav row + register),
 * never correctness (dimensions plan §2).
 *
 * Toggling ON runs the "Importera befintliga koder" scan
 * (POST /api/dimensions/import-existing): codes already present on
 * journal_entry_lines.dimensions but missing from the registry are created as
 * archived placeholder values, and the user is told how many were found.
 */
export function DimensionsToggle() {
  const t = useTranslations('dimensions')
  const errorLocale = useLocale() as ErrorLocale
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  const enabled = settings?.dimensions_enabled ?? false

  async function handleChange(next: boolean) {
    setIsSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dimensions_enabled: next }),
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
      updateSettings({ dimensions_enabled: next })

      if (next) {
        // Import scan: registry rows for codes already used on lines. Failure
        // is non-fatal: the toggle stays on and the scan can be re-run by
        // toggling again.
        try {
          const importRes = await fetch('/api/dimensions/import-existing', {
            method: 'POST',
          })
          const importJson = await importRes.json().catch(() => null)
          if (importRes.ok) {
            const created: number =
              importJson?.created ?? importJson?.data?.created ?? 0
            if (created > 0) {
              toast({
                title: t('settings_imported_toast_title'),
                description: t('settings_imported_toast', { count: created }),
              })
            }
          } else {
            toast({
              title: t('settings_import_failed_title'),
              description: getErrorMessage(importJson, { locale: errorLocale }),
              variant: 'destructive',
            })
          }
        } catch {
          toast({
            title: t('settings_import_failed_title'),
            variant: 'destructive',
          })
        }
      }
    } catch (err) {
      // A rejected fetch (offline, DNS failure, aborted request) never reaches
      // the !res.ok arm above, and the switch is controlled by the settings
      // context, so it simply stays where it was: without this toast the click
      // looks like a dead control rather than a save that did not happen.
      // One toast per failed click, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
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
        id="dimensions-enabled"
        checked={enabled}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={locked}
      />
      <label
        htmlFor="dimensions-enabled"
        className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}
      >
        {t('settings_toggle_label')}
      </label>
      {enabled && (
        <SettingsRowEnd>
          <Link
            href="/dimensions"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('settings_open_register')}
          </Link>
        </SettingsRowEnd>
      )}
    </SettingsRow>
  )
}
