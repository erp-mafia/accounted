'use client'

import { useTranslations } from 'next-intl'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

interface PeriodLockingSettingsProps {
  settings: CompanySettings
}

/**
 * Period-lock rows. Uncontrolled on purpose: the values are read via FormData
 * by the surrounding SettingsFormWrapper on the bookkeeping settings page.
 */
export function PeriodLockingSettings({ settings }: PeriodLockingSettingsProps) {
  const t = useTranslations('settings_period_locking')
  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow
        label={t('locked_through_label')}
        htmlFor="bookkeeping_locked_through"
        help={t('locked_through_help')}
        align="baseline"
      >
        <SettingsInput
          id="bookkeeping_locked_through"
          name="bookkeeping_locked_through"
          type="date"
          defaultValue={settings.bookkeeping_locked_through || ''}
          className="max-w-44 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('auto_lock_label')}
        htmlFor="auto_lock_period_days"
        help={t('auto_lock_help')}
      >
        <SettingsSelect
          id="auto_lock_period_days"
          name="auto_lock_period_days"
          defaultValue={settings.auto_lock_period_days?.toString() || 'none'}
        >
          <option value="none">{t('auto_lock_none')}</option>
          <option value="30">{t('auto_lock_30')}</option>
          <option value="60">{t('auto_lock_60')}</option>
          <option value="90">{t('auto_lock_90')}</option>
        </SettingsSelect>
      </SettingsRow>
    </SettingsGroup>
  )
}
