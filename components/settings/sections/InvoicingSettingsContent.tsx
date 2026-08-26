'use client'

import { useTranslations } from 'next-intl'
import { InvoiceSettingsForm } from '@/components/settings/InvoiceSettingsForm'
import { InvoicePaymentLinkSettings } from '@/components/settings/InvoicePaymentLinkSettings'
import { PeppolReceiveSettings } from '@/components/settings/PeppolReceiveSettings'
import { InvoicePaymentAccountsSettings } from '@/components/settings/InvoicePaymentAccountsSettings'
import { InvoiceEmailTextsSettings } from '@/components/settings/InvoiceEmailTextsSettings'
import { InvoiceEmailRecipientsSettings } from '@/components/settings/InvoiceEmailRecipientsSettings'
import { InvoiceSenderDomainSettings } from '@/components/settings/InvoiceSenderDomainSettings'
import { InvoicePreviewCard } from '@/components/settings/InvoicePreviewCard'
import { PdfPrintSettings } from '@/components/settings/PdfPrintSettings'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export function InvoicingSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { settings, isLoading, updateSettings, refetch } = useSettings()

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const updates: Record<string, unknown> = {
      invoice_prefix: (formData.get('invoice_prefix') as string) || null,
      next_invoice_number: parseInt(formData.get('next_invoice_number') as string) || 1,
      next_arrival_number: parseInt(formData.get('next_arrival_number') as string) || 1,
      invoice_default_days: parseInt(formData.get('invoice_default_days') as string) || 30,
      invoice_default_notes: (formData.get('invoice_default_notes') as string) || null,
      default_our_reference: (formData.get('default_our_reference') as string) || null,
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
      <SettingsSectionHeader
        title={tNav('invoicing')}
        intro={tIntro('invoicing')}
        action={<InvoicePreviewCard settings={settings} />}
      />

      {/* Owner/admin only: the component gates itself on role. */}
      <InvoicePaymentAccountsSettings settings={settings} onUpdate={updateSettings} />

      <SettingsFormWrapper onSave={handleSave}>
        <InvoiceSettingsForm settings={settings} />
      </SettingsFormWrapper>

      {/* Payment link opt-in: saves individually via toggle switch */}
      <InvoicePaymentLinkSettings settings={settings} onUpdate={updateSettings} />

      {/* Peppol receiving: one switch that publishes the company's Peppol id */}
      <PeppolReceiveSettings />

      {/* PDF settings: saves individually via toggle switches */}
      <PdfPrintSettings settings={settings} onUpdate={updateSettings} />

      {/* Fixed invoice email recipients: explicit save (owner/admin only) */}
      <InvoiceEmailRecipientsSettings settings={settings} onUpdate={updateSettings} />

      <InvoiceSenderDomainSettings companyName={settings.company_name ?? null} />

      {/* Invoice email texts: autosaves on blur */}
      <InvoiceEmailTextsSettings settings={settings} onUpdate={updateSettings} />
    </div>
  )
}
