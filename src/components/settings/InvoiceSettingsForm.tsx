'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { useFormat } from '@/lib/hooks/use-format'
import type { CompanySettings } from '@/types'

interface InvoiceSettingsFormProps {
  settings: CompanySettings
  /** Rendered after Fakturainställningar (self-saving controls). */
  afterInvoiceSettings?: React.ReactNode
}

export function InvoiceSettingsForm({ settings, afterInvoiceSettings }: InvoiceSettingsFormProps) {
  const t = useTranslations('settings_invoice_form')
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

      {afterInvoiceSettings}

    </>
  )
}

/**
 * Betalningspåminnelser: whether reminders are on and after how many days.
 * Lives on Försäljning → Utskick since 2026-09-24; the host wraps it in its
 * own SettingsFormWrapper and mounts it only while REMINDERS_SENDING_ENABLED.
 *
 * Reminders go on and off in TurnOnRemindersSheet, the same sheet as on the
 * invoice list (the collections rule, the pick list and the turn-off
 * warning live there): this row shows the state and opens it, also for a
 * company with no overdue invoice to offer. The form saves only the days, so
 * a stale tab can never turn reminders off with the state it read on mount.
 */
export function InvoiceReminderSettingsForm({
  settings,
  onOpenReminders,
}: {
  settings: CompanySettings
  onOpenReminders: () => void
}) {
  const t = useTranslations('settings_invoice_form')
  const { formatDateLong } = useFormat()
  const on = settings.send_invoice_reminders === true
  const enabledAt = settings.reminders_enabled_at ?? null
  return (
    <SettingsGroup label={t('reminder_days_heading')} help={t('reminder_days_help')}>
        <SettingsRow label={t('send_reminders_label')} help={t('send_reminders_help')} borderless={on}>
          <SettingsRowNote fill className={on ? 'text-foreground' : undefined}>
            {on
              ? enabledAt
                ? t('send_reminders_on', { date: formatDateLong(enabledAt) })
                : t('send_reminders_on_undated')
              : t('send_reminders_off')}
          </SettingsRowNote>
          <SettingsRowEnd>
            <Button type="button" variant="outline" size="sm" onClick={onOpenReminders}>
              {on ? t('send_reminders_manage') : t('send_reminders_turn_on')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
        <SettingsReveal open={on}>
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
              className="tabular-nums"
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
              className="tabular-nums"
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
              className="tabular-nums"
            />
          </SettingsRow>
        </SettingsReveal>
      </SettingsGroup>
  )
}
