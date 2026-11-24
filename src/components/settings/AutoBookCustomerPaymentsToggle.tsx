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
 * The company's switch for booking an incoming payment against the customer
 * invoice it names by OCR or invoice number, without a person
 * (company_settings.auto_book_customer_payments, crm#2226;
 * lib/invoices/customer-payment-auto-book.ts). Off by default. Saved through
 * the standard settings PUT (owner or admin), audited like every setting.
 */
export function AutoBookCustomerPaymentsToggle() {
  const t = useTranslations('settings_bookkeeping')
  const { settings, updateSettings } = useSettings()
  const { canWrite } = useCanWrite()
  const saveSettings = useSaveSettings()
  const [isSaving, setIsSaving] = useState(false)

  // The column defaults to off; a row read before the migration has no key.
  const enabled = settings?.auto_book_customer_payments === true

  async function handleChange(next: boolean) {
    setIsSaving(true)
    const saved = await saveSettings(
      { auto_book_customer_payments: next },
      { failedTitle: t('auto_book_customer_payments_save_failed') },
    )
    if (saved) updateSettings({ auto_book_customer_payments: next })
    setIsSaving(false)
  }

  const locked = isSaving || !canWrite

  return (
    <SettingsRow label={t('auto_book_customer_payments_label')} help={t('auto_book_customer_payments_help')}>
      <Switch
        id="auto-book-customer-payments"
        checked={enabled}
        onCheckedChange={(next) => void handleChange(next)}
        disabled={locked}
      />
      <label
        htmlFor="auto-book-customer-payments"
        className={cn('text-sm', locked ? 'text-muted-foreground' : 'cursor-pointer')}
      >
        {enabled ? t('auto_book_customer_payments_on') : t('auto_book_customer_payments_off')}
      </label>
    </SettingsRow>
  )
}
