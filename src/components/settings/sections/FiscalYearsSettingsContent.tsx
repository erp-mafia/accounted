'use client'

import { useTranslations } from 'next-intl'
import { FiscalPeriodEditor } from '@/components/settings/FiscalPeriodEditor'
import { FiscalYearsManager } from '@/components/settings/FiscalYearsManager'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { fiscalYearLockedToCalendar, isEntityType } from '@/lib/company/entity-type'
import type { CompanySettings } from '@/types'

/**
 * Bokföring → Räkenskapsår: everything about fiscal years in one place. Until
 * 2026-09-24 the start month sat under Skatt, the first fiscal year under
 * Företag and the list of years under Bokföring.
 */
export function FiscalYearsSettingsContent() {
  const t = useTranslations('settings_tax_form')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { settings, isLoading, updateSettings, refetch } = useSettings()

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  // A form bound to the calendar year (BFL 3 kap. 1 §, enskild firma) sees
  // the month, it does not choose it.
  const calendarOnly =
    isEntityType(settings.entity_type) && fiscalYearLockedToCalendar(settings.entity_type)
  const months = [
    t('month_jan'), t('month_feb'), t('month_mar'), t('month_apr'),
    t('month_may'), t('month_jun'), t('month_jul'), t('month_aug'),
    t('month_sep'), t('month_oct'), t('month_nov'), t('month_dec'),
  ]

  function handleSave(formData: FormData) {
    return {
      updates: {
        fiscal_year_start_month: parseInt(formData.get('fiscal_year_start_month') as string) || 1,
      },
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('fiscal_years')} intro={tIntro('fiscal_years')} />

      <SettingsFormWrapper onSave={handleSave}>
        <SettingsGroup>
          <SettingsRow
            label={t('fiscal_year_start_label')}
            htmlFor="fiscal_year_start_month"
            help={calendarOnly ? t('fiscal_year_ef_help') : t('fiscal_year_change_help')}
          >
            {calendarOnly ? (
              <>
                <SettingsInput id="fiscal_year_start_month" value={t('month_jan')} disabled />
                <input type="hidden" name="fiscal_year_start_month" value="1" />
              </>
            ) : (
              <SettingsSelect
                id="fiscal_year_start_month"
                name="fiscal_year_start_month"
                defaultValue={String(settings.fiscal_year_start_month || 1)}
              >
                {months.map((month, i) => (
                  <option key={i + 1} value={String(i + 1)}>{month}</option>
                ))}
              </SettingsSelect>
            )}
          </SettingsRow>
        </SettingsGroup>
      </SettingsFormWrapper>

      <FiscalPeriodEditor />

      <FiscalYearsManager />
    </div>
  )
}
