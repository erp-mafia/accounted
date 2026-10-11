'use client'

import { useTranslations } from 'next-intl'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { CompanySettings } from '@/types'

interface CompanyInfoFormProps {
  settings: CompanySettings
  /**
   * Opens the delete-company dialog from the locked org number row. Passed
   * only where that way out exists (the section decides: owner, not a
   * sandbox); without it the row is the plain locked field.
   */
  onWrongCompany?: () => void
}

export function CompanyInfoForm({ settings, onWrongCompany }: CompanyInfoFormProps) {
  const t = useTranslations('settings_company')
  const orgLocked = settings.onboarding_complete === true
  // Säte belongs to a legal person; a form whose org number is the owner's
  // personnummer (enskild firma) has none.
  const hasRegisteredOffice = !(
    isEntityType(settings.entity_type) && usesPersonnummerAsOrgNumber(settings.entity_type)
  )
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
        {/* A locked field alone is a dead end: an owner who set up the wrong
            company comes here to change the number, and the reason behind the
            "?" says only that it cannot be done. One muted sentence with the
            way out, on its own line under the field. */}
        {orgLocked && onWrongCompany && (
          <SettingsRowNote className="basis-full">
            {t('org_number_wrong_company')}{' '}
            <button
              type="button"
              onClick={onWrongCompany}
              className="underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
            >
              {t('org_number_wrong_company_action')}
            </button>
          </SettingsRowNote>
        )}
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
      {hasRegisteredOffice && (
        <SettingsRow
          label={t('registered_office_label')}
          htmlFor="registered_office"
          help={t('registered_office_help')}
          align="baseline"
        >
          <SettingsInput
            id="registered_office"
            name="registered_office"
            defaultValue={settings.registered_office || ''}
          />
        </SettingsRow>
      )}
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
