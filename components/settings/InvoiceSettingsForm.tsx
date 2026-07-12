'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { CompanySettings } from '@/types'

interface InvoiceSettingsFormProps {
  settings: CompanySettings
}

export function InvoiceSettingsForm({ settings }: InvoiceSettingsFormProps) {
  const t = useTranslations('settings_invoice_form')
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('heading')}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
        <div className="space-y-2">
          <Label htmlFor="invoice_prefix">{t('prefix_label')}</Label>
          <Input
            id="invoice_prefix"
            name="invoice_prefix"
            placeholder={t('prefix_placeholder')}
            defaultValue={settings.invoice_prefix || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="next_invoice_number">{t('next_number_label')}</Label>
          <Input
            id="next_invoice_number"
            name="next_invoice_number"
            type="number"
            min="1"
            defaultValue={settings.next_invoice_number || 1}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice_default_days">{t('default_days_label')}</Label>
          <Input
            id="invoice_default_days"
            name="invoice_default_days"
            type="number"
            min="0"
            defaultValue={settings.invoice_default_days || 30}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="next_arrival_number">{t('arrival_start_label')}</Label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            id="next_arrival_number"
            name="next_arrival_number"
            type="number"
            min="1"
            defaultValue={settings.next_arrival_number || 1}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t('arrival_start_help')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="invoice_default_notes">{t('default_notes_label')}</Label>
        <Textarea
          id="invoice_default_notes"
          name="invoice_default_notes"
          rows={3}
          placeholder={t('default_notes_placeholder')}
          defaultValue={settings.invoice_default_notes || ''}
        />
        <p className="text-xs text-muted-foreground">
          {t('default_notes_help')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default_our_reference">{t('default_our_reference_label')}</Label>
        <Input
          id="default_our_reference"
          name="default_our_reference"
          placeholder={t('default_our_reference_placeholder')}
          defaultValue={settings.default_our_reference || ''}
        />
        <p className="text-xs text-muted-foreground">
          {t('default_our_reference_help')}
        </p>
      </div>
    </section>
  )
}
