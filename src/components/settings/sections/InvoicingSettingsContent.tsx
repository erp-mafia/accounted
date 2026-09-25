'use client'

import { useTranslations } from 'next-intl'
import { InvoiceSettingsForm } from '@/components/settings/InvoiceSettingsForm'
import { InvoiceTypesSettings } from '@/components/settings/InvoiceTypesSettings'
import { InvoicePaymentLinkSettings } from '@/components/settings/InvoicePaymentLinkSettings'
import { InvoicePaymentAccountsSettings } from '@/components/settings/InvoicePaymentAccountsSettings'
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
        <InvoiceSettingsForm
          settings={settings}
          // Invoice kinds on/off, right after Fakturainställningar: each
          // switch saves itself, independent of the form's Spara.
          afterInvoiceSettings={<InvoiceTypesSettings />}
        />
      </SettingsFormWrapper>

      {/* Payment link opt-in: saves individually via toggle switch */}
      <InvoicePaymentLinkSettings settings={settings} onUpdate={updateSettings} />

      {/* PDF settings: saves individually via toggle switches */}
      <PdfPrintSettings settings={settings} onUpdate={updateSettings} />
    </div>
  )
}
