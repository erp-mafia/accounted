'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { TurnOnRemindersSheet } from '@/components/reminders/TurnOnRemindersSheet'
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
import type { ReminderOverview } from '@/lib/reminders/overview'
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
  const [remindersOpen, setRemindersOpen] = useState(false)

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  // Only the days: reminders go on and off in the sheet. The settings API
  // still takes send_invoice_reminders (API and MCP callers); this form never
  // sends it, so a tab opened before a turn-on cannot turn reminders off.
  function handleSave(formData: FormData) {
    const updates: Record<string, unknown> = {
      reminder_days_level_1:
        Number.parseInt(formData.get('reminder_days_level_1') as string) || 15,
      reminder_days_level_2:
        Number.parseInt(formData.get('reminder_days_level_2') as string) || 30,
      reminder_days_level_3:
        Number.parseInt(formData.get('reminder_days_level_3') as string) || 45,
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  // After the sheet turned reminders on or off or saved the days: the row and the day fields follow.
  function handleRemindersChanged(overview: ReminderOverview) {
    updateSettings({
      send_invoice_reminders: overview.enabled,
      reminders_enabled_at: overview.enabledAt,
      reminder_days_level_1: overview.schedule.days[0],
      reminder_days_level_2: overview.schedule.days[1],
      reminder_days_level_3: overview.schedule.days[2],
    })
  }
  const savedDays = [settings.reminder_days_level_1, settings.reminder_days_level_2, settings.reminder_days_level_3].join('-')

  return (
    <div>
      <SettingsSectionHeader title={tNav('sending')} intro={tIntro('sending')} />

      <InvoiceSenderDomainSettings companyName={settings.company_name ?? null} />

      {/* Fixed invoice email recipients: explicit save (owner/admin only) */}
      <InvoiceEmailRecipientsSettings settings={settings} onUpdate={updateSettings} />

      {/* Invoice email texts: autosaves on blur */}
      <InvoiceEmailTextsSettings settings={settings} onUpdate={updateSettings} />

      {/* The reminder schedule only renders while reminder sending exists:
          with it switched off product-wide, a status row and three day
          fields that change nothing are noise. The saved values stay untouched in
          company_settings, since the form (and its save) is not mounted. */}
      {REMINDERS_SENDING_ENABLED && (
        <>
          <SettingsFormWrapper onSave={handleSave}>
            {/* Keyed by the saved days: the uncontrolled fields take the days the sheet saved. */}
            <InvoiceReminderSettingsForm key={savedDays} settings={settings} onOpenReminders={() => setRemindersOpen(true)} />
          </SettingsFormWrapper>
          {/* Outside the form: React events cross the sheet's portal, and its fields must not mark this form dirty. */}
          <TurnOnRemindersSheet open={remindersOpen} onOpenChange={setRemindersOpen} onChanged={handleRemindersChanged} />
        </>
      )}
    </div>
  )
}
