'use client'

import { useTranslations } from 'next-intl'
import { InvoiceReminderSettingsForm } from '@/components/settings/InvoiceSettingsForm'
import { InvoiceEmailTextsSettings } from '@/components/settings/InvoiceEmailTextsSettings'
import { InvoiceEmailRecipientsSettings } from '@/components/settings/InvoiceEmailRecipientsSettings'
import { InvoiceSenderDomainSettings } from '@/components/settings/InvoiceSenderDomainSettings'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import type { CompanySettings } from '@/types'

/**
 * Försäljning → Utskick: who invoice mail comes from, where replies and copies
 * go, what the invoice mails say, and (while reminder sending exists) when
 * reminders go out. Split out of Fakturering on 2026-09-24, which had grown to
 * ten blocks.
 */
export function SendingSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { settings, isLoading, updateSettings, refetch } = useSettings()

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const updates: Record<string, unknown> = {
      reminder_days_level_1:
        Number.parseInt(formData.get('reminder_days_level_1') as string) || 15,
      reminder_days_level_2:
        Number.parseInt(formData.get('reminder_days_level_2') as string) || 30,
      reminder_days_level_3:
        Number.parseInt(formData.get('reminder_days_level_3') as string) || 45,
      send_invoice_reminders: formData.get('send_invoice_reminders') === 'true',
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('sending')} intro={tIntro('sending')} />

      <InvoiceSenderDomainSettings companyName={settings.company_name ?? null} />

      {/* Fixed invoice email recipients: explicit save (owner/admin only) */}
      <InvoiceEmailRecipientsSettings settings={settings} onUpdate={updateSettings} />

      {/* Invoice email texts: autosaves on blur */}
      <InvoiceEmailTextsSettings settings={settings} onUpdate={updateSettings} />

      {/* The reminder schedule only renders while automatic sending exists:
          with it switched off product-wide, a switch and three day fields
          that change nothing are noise. The saved values stay untouched in
          company_settings, since the form (and its save) is not mounted. */}
      {REMINDERS_SENDING_ENABLED && (
        <SettingsFormWrapper onSave={handleSave}>
          <InvoiceReminderSettingsForm settings={settings} />
        </SettingsFormWrapper>
      )}
    </div>
  )
}
