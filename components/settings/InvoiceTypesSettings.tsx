'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  INVOICE_TYPE_TOGGLES,
  isInvoiceTypeEnabled,
  type InvoiceTypeToggle,
} from '@/lib/invoices/invoice-type-toggles'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * Company-level on/off switches for the optional invoice kinds (offert,
 * proforma, återkommande, självfaktura). Each persists its own
 * company_settings column through the standard settings PUT, same as the
 * öresavrundning switch. The flags gate UI visibility only (the Ny faktura
 * menu, the list views, the editor's type picker), never correctness:
 * documents of a hidden kind keep working through the API/MCP, stay listed
 * under Alla and stay reachable by URL.
 */
export function InvoiceTypesSettings() {
  const t = useTranslations('settings_invoice_types')
  const errorLocale = useLocale() as ErrorLocale
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [saving, setSaving] = useState<InvoiceTypeToggle | null>(null)

  async function handleChange(toggle: InvoiceTypeToggle, next: boolean) {
    setSaving(toggle)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [toggle]: next }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('save_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      // The invoice list and editor read the same SWR row, so the patch
      // reaches them without a reload; no server-rendered nav depends on it.
      updateSettings({ [toggle]: next })
    } catch (err) {
      // A rejected fetch never reaches the !res.ok arm, and the switch is
      // controlled by the settings context, so it stays put: without this
      // toast the click looks like a dead control rather than a failed save.
      toast({
        title: t('save_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <SettingsGroup label={t('heading')} help={t('heading_help')}>
      {INVOICE_TYPE_TOGGLES.map((toggle) => {
        const id = `invoice-type-${toggle}`
        const locked = saving === toggle || !canWrite
        return (
          <SettingsRow key={toggle} label={t(`${toggle}_label`)} help={t(`${toggle}_help`)}>
            <Switch
              id={id}
              checked={isInvoiceTypeEnabled(settings, toggle)}
              onCheckedChange={(next) => void handleChange(toggle, next)}
              disabled={locked}
            />
            <label
              htmlFor={id}
              className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}
            >
              {t('toggle_label')}
            </label>
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
