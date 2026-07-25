'use client'

import { useTranslations } from 'next-intl'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
} from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

interface CompanyInfoFormProps {
  settings: CompanySettings
}

export function CompanyInfoForm({ settings }: CompanyInfoFormProps) {
  const t = useTranslations('settings_company')
  const orgLocked = settings.onboarding_complete === true
  return (
    <SettingsGroup label={t('company_info_heading')}>
      <SettingsRow
        label={t('company_name_label')}
        htmlFor="company_name"
        help={t('company_name_help')}
        align="baseline"
      >
        <SettingsInput
          id="company_name"
          name="company_name"
          defaultValue={settings.company_name || ''}
        />
      </SettingsRow>
      <SettingsRow
        label={t('org_number_label')}
        htmlFor="org_number"
        help={orgLocked ? t('org_number_locked') : undefined}
        align="baseline"
      >
        <SettingsInput
          id="org_number"
          name="org_number"
          defaultValue={settings.org_number || ''}
          disabled={orgLocked}
        />
      </SettingsRow>
      <SettingsRow label={t('address_label')} htmlFor="address_line1" align="baseline">
        <SettingsInput
          id="address_line1"
          name="address_line1"
          defaultValue={settings.address_line1 || ''}
        />
      </SettingsRow>
      <SettingsRow label={t('postal_code_label')} htmlFor="postal_code" align="baseline">
        <SettingsInput
          id="postal_code"
          name="postal_code"
          defaultValue={settings.postal_code || ''}
          className="max-w-24 flex-none"
        />
      </SettingsRow>
      <SettingsRow label={t('city_label')} htmlFor="city" align="baseline">
        <SettingsInput id="city" name="city" defaultValue={settings.city || ''} />
      </SettingsRow>
      <SettingsRow label={t('phone_label')} htmlFor="phone" align="baseline">
        <SettingsInput
          id="phone"
          name="phone"
          type="tel"
          defaultValue={settings.phone || ''}
        />
      </SettingsRow>
      <SettingsRow label={t('email_label')} htmlFor="email" align="baseline">
        <SettingsInput
          id="email"
          name="email"
          type="email"
          defaultValue={settings.email || ''}
        />
      </SettingsRow>
      <SettingsRow label={t('website_label')} htmlFor="website" align="baseline">
        <SettingsInput
          id="website"
          name="website"
          defaultValue={settings.website || ''}
          placeholder="https://"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
