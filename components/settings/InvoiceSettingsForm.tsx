'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { AttnLine } from '@/components/ui/attn-line'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import type { CompanySettings } from '@/types'

interface InvoiceSettingsFormProps {
  settings: CompanySettings
}

export function InvoiceSettingsForm({ settings }: InvoiceSettingsFormProps) {
  const t = useTranslations('settings_invoice_form')
  const [sendReminders, setSendReminders] = useState(settings.send_invoice_reminders ?? true)
  return (
    <>
      <SettingsGroup label={t('heading')}>
        <SettingsRow label={t('prefix_label')} htmlFor="invoice_prefix" align="baseline">
          <SettingsInput
            id="invoice_prefix"
            name="invoice_prefix"
            placeholder={t('prefix_placeholder')}
            defaultValue={settings.invoice_prefix || ''}
            className="max-w-32 flex-none"
          />
        </SettingsRow>
        <SettingsRow
          label={t('next_number_label')}
          htmlFor="next_invoice_number"
          align="baseline"
        >
          <SettingsInput
            id="next_invoice_number"
            name="next_invoice_number"
            type="number"
            min="1"
            defaultValue={settings.next_invoice_number || 1}
            className="max-w-32 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow
          label={t('default_days_label')}
          htmlFor="invoice_default_days"
          align="baseline"
        >
          <SettingsInput
            id="invoice_default_days"
            name="invoice_default_days"
            type="number"
            min="0"
            defaultValue={settings.invoice_default_days || 30}
            className="max-w-24 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow
          label={t('arrival_start_label')}
          htmlFor="next_arrival_number"
          help={t('arrival_start_help')}
          align="baseline"
        >
          <SettingsInput
            id="next_arrival_number"
            name="next_arrival_number"
            type="number"
            min="1"
            defaultValue={settings.next_arrival_number || 1}
            className="max-w-32 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow
          label={t('default_notes_label')}
          htmlFor="invoice_default_notes"
          help={t('default_notes_help')}
          align="baseline"
        >
          <SettingsTextarea
            id="invoice_default_notes"
            name="invoice_default_notes"
            rows={3}
            placeholder={t('default_notes_placeholder')}
            defaultValue={settings.invoice_default_notes || ''}
          />
        </SettingsRow>
        <SettingsRow
          label={t('default_our_reference_label')}
          htmlFor="default_our_reference"
          help={t('default_our_reference_help')}
          align="baseline"
        >
          <SettingsInput
            id="default_our_reference"
            name="default_our_reference"
            placeholder={t('default_our_reference_placeholder')}
            defaultValue={settings.default_our_reference || ''}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('reminder_days_heading')} help={t('reminder_days_help')}>
        {!REMINDERS_SENDING_ENABLED && (
          <AttnLine className="px-1 pt-2">{t('sending_disabled_notice')}</AttnLine>
        )}
        <SettingsRow
          label={t('send_reminders_label')}
          htmlFor="send_invoice_reminders"
          help={t('send_reminders_help')}
          borderless={sendReminders}
        >
          <Switch
            id="send_invoice_reminders"
            checked={sendReminders}
            onCheckedChange={(v) => setSendReminders(v === true)}
          />
          <input type="hidden" name="send_invoice_reminders" value={sendReminders ? 'true' : 'false'} />
        </SettingsRow>
        <SettingsReveal open={sendReminders}>
          <SettingsRow
            label={t('reminder_days_level_1')}
            htmlFor="reminder_days_level_1"
            align="baseline"
          >
            <SettingsInput
              id="reminder_days_level_1"
              name="reminder_days_level_1"
              type="number"
              min="1"
              max="365"
              defaultValue={settings.reminder_days_level_1 ?? 15}
              className="max-w-24 flex-none tabular-nums"
            />
          </SettingsRow>
          <SettingsRow
            label={t('reminder_days_level_2')}
            htmlFor="reminder_days_level_2"
            align="baseline"
          >
            <SettingsInput
              id="reminder_days_level_2"
              name="reminder_days_level_2"
              type="number"
              min="1"
              max="365"
              defaultValue={settings.reminder_days_level_2 ?? 30}
              className="max-w-24 flex-none tabular-nums"
            />
          </SettingsRow>
          <SettingsRow
            label={t('reminder_days_level_3')}
            htmlFor="reminder_days_level_3"
            align="baseline"
          >
            <SettingsInput
              id="reminder_days_level_3"
              name="reminder_days_level_3"
              type="number"
              min="1"
              max="365"
              defaultValue={settings.reminder_days_level_3 ?? 45}
              className="max-w-24 flex-none tabular-nums"
            />
          </SettingsRow>
        </SettingsReveal>
      </SettingsGroup>
    </>
  )
}
