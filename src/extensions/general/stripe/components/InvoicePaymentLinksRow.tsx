'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { HelpPopover } from '@/components/ui/help-popover'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useCompanySettings } from '@/lib/reference-data/hooks'

/**
 * The invoice payment-link opt-in, shown on the connected Stripe card.
 *
 * Connecting Stripe alone never adds links: the send paths also require
 * company_settings.invoice_payment_links_enabled (default false, enforced in
 * lib/extensions/payment-links.ts). The switch used to live only under
 * Settings > Invoicing, so connected merchants were told links come
 * automatically and never got one. Same column and save path as that
 * switch; the SWR cache is shared, so both always show the same state.
 */
export function InvoicePaymentLinksRow() {
  const t = useTranslations('settings_payments')
  const { settings, isLoading, updateSettings } = useCompanySettings()
  const saveSettings = useSaveSettings()
  const [saving, setSaving] = useState(false)
  const enabled = settings?.invoice_payment_links_enabled === true

  async function handleToggle(value: boolean) {
    setSaving(true)
    const saved = await saveSettings(
      { invoice_payment_links_enabled: value },
      { failedTitle: t('invoice_links_save_failed') },
    )
    if (saved) updateSettings({ invoice_payment_links_enabled: value })
    setSaving(false)
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t-hairline pt-4">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {t('invoice_links_title')}
          <HelpPopover className="shrink-0">
            <p>{t('invoice_links_help')}</p>
          </HelpPopover>
        </p>
        {settings && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {enabled ? t('invoice_links_on') : t('invoice_links_off')}
          </p>
        )}
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={saving || isLoading || !settings}
        aria-label={t('invoice_links_title')}
      />
    </div>
  )
}
