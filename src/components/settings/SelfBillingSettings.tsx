'use client'

import { useTranslations } from 'next-intl'
import { SettingsGroup, SettingsInput, SettingsRow, SettingsTextarea } from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

/**
 * Självfakturor on the purchase side (crm#1367): the series the company's
 * self-billing invoices are numbered in and the acceptance clause their
 * document prints. Saved with the invoicing form's Spara
 * (selfBillingSettingsUpdates). The series never reuses a number, whatever
 * the next number says: the database floors it at the highest one issued.
 */
export function SelfBillingSettings({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('settings_self_billing')
  return (
    <SettingsGroup label={t('heading')} help={t('heading_help')}>
      <SettingsRow label={t('prefix_label')} htmlFor="self_billing_prefix" help={t('prefix_help')} align="baseline">
        <SettingsInput
          id="self_billing_prefix"
          name="self_billing_prefix"
          maxLength={12}
          defaultValue={settings.self_billing_prefix ?? 'SF-'}
          className="max-w-32 flex-none"
        />
      </SettingsRow>
      <SettingsRow label={t('next_number_label')} htmlFor="next_self_billing_number" help={t('next_number_help')} align="baseline">
        <SettingsInput
          id="next_self_billing_number"
          name="next_self_billing_number"
          type="number"
          min="1"
          defaultValue={settings.next_self_billing_number || 1}
          className="max-w-32 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('acceptance_label')}
        htmlFor="self_billing_acceptance_text"
        help={t('acceptance_help')}
        align="baseline"
        borderless
      >
        <SettingsTextarea
          id="self_billing_acceptance_text"
          name="self_billing_acceptance_text"
          maxLength={1000}
          placeholder={t('acceptance_placeholder')}
          defaultValue={settings.self_billing_acceptance_text ?? ''}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** The self-billing fields of the invoicing form, as the settings PUT takes them. */
export function selfBillingSettingsUpdates(formData: FormData): Partial<CompanySettings> {
  const prefix = formData.get('self_billing_prefix')
  const next = parseInt(String(formData.get('next_self_billing_number') ?? ''), 10)
  const acceptance = String(formData.get('self_billing_acceptance_text') ?? '').trim()
  return {
    ...(typeof prefix === 'string' ? { self_billing_prefix: prefix.trim() } : {}),
    ...(Number.isInteger(next) && next >= 1 ? { next_self_billing_number: next } : {}),
    self_billing_acceptance_text: acceptance === '' ? null : acceptance,
  }
}
