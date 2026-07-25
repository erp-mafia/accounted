'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
} from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

interface InvoicePaymentLinkSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

/**
 * Opt-in for the invoice payment-link feature. Off (the default) hides the
 * payment-link field in the invoice editor and stops automatic Stripe link
 * creation on send; the send routes enforce the same setting server-side.
 */
export function InvoicePaymentLinkSettings({ settings, onUpdate }: InvoicePaymentLinkSettingsProps) {
  const t = useTranslations('settings_payment_links')
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  const saveToggle = useCallback(async (value: boolean) => {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_payment_links_enabled: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ invoice_payment_links_enabled: value })
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }, [onUpdate, toast, t])

  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow label={t('enable_label')} help={t('enable_help')}>
        <SettingsRowEnd>
          <Switch
            checked={settings.invoice_payment_links_enabled ?? false}
            onCheckedChange={saveToggle}
            disabled={isSaving}
            aria-label={t('enable_label')}
          />
        </SettingsRowEnd>
      </SettingsRow>
    </SettingsGroup>
  )
}
