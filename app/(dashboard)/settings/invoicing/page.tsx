'use client'

import { BankDetailsForm, validateBankFields } from '@/components/settings/BankDetailsForm'
import { InvoiceSettingsForm } from '@/components/settings/InvoiceSettingsForm'
import { PdfPrintSettings } from '@/components/settings/PdfPrintSettings'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { useSettings } from '@/components/settings/useSettings'
import { useToast } from '@/components/ui/use-toast'
import type { CompanySettings } from '@/types'

export default function InvoicingSettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()
  const { toast } = useToast()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const bankErrors = validateBankFields(formData)
    if (bankErrors.length > 0) {
      toast({
        title: 'Kontrollera bankuppgifter',
        description: bankErrors.map(e => e.message).join(', '),
        variant: 'destructive',
      })
      return {}
    }

    const updates: Record<string, unknown> = {
      bank_name: formData.get('bank_name') as string,
      clearing_number: formData.get('clearing_number') as string,
      account_number: formData.get('account_number') as string,
      bankgiro: (formData.get('bankgiro') as string) || null,
      invoice_prefix: (formData.get('invoice_prefix') as string) || null,
      next_invoice_number: parseInt(formData.get('next_invoice_number') as string) || 1,
      invoice_default_days: parseInt(formData.get('invoice_default_days') as string) || 30,
      invoice_default_notes: (formData.get('invoice_default_notes') as string) || null,
    }
    updateSettings(updates as Partial<CompanySettings>)
    return updates
  }

  return (
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        <BankDetailsForm settings={settings} />
        <div className="border-t border-border/8 pt-8">
          <InvoiceSettingsForm settings={settings} />
        </div>
      </SettingsFormWrapper>

      {/* PDF settings — saves individually via toggle switches */}
      <div className="border-t border-border/8 pt-8">
        <PdfPrintSettings settings={settings} onUpdate={updateSettings} />
      </div>
    </div>
  )
}
