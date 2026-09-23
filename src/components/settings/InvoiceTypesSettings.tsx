'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { HelpPopover } from '@/components/ui/help-popover'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  INVOICE_TYPE_TOGGLES,
  isInvoiceTypeEnabled,
  type InvoiceTypeToggle,
} from '@/lib/invoices/invoice-type-toggles'
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
  const router = useRouter()
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
      // reaches them without a reload. The Offerter nav row is gated by the
      // server-rendered dashboard layout, so it needs a refresh to follow.
      updateSettings({ [toggle]: next })
      if (toggle === 'quotes_enabled') router.refresh()
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
      {/* Compact switch rows two abreast, same grid as the PDF show/hide switches. */}
      <div className="grid gap-x-8 md:grid-cols-2">
        {INVOICE_TYPE_TOGGLES.map((toggle) => {
          const id = `invoice-type-${toggle}`
          return (
            <div
              key={toggle}
              className="flex items-center justify-between gap-3 border-b border-border px-1 py-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <label htmlFor={id} className="truncate text-sm">
                  {t(`${toggle}_label`)}
                </label>
                <HelpPopover className="shrink-0">{t(`${toggle}_help`)}</HelpPopover>
              </span>
              <Switch
                id={id}
                checked={isInvoiceTypeEnabled(settings, toggle)}
                onCheckedChange={(next) => void handleChange(toggle, next)}
                disabled={saving === toggle || !canWrite}
              />
            </div>
          )
        })}
      </div>
    </SettingsGroup>
  )
}
