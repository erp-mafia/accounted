'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
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
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/components/settings/useSettings'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import type { CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const BANK_OPTIONS = ['swedbank', 'seb', 'handelsbanken', 'nordea'] as const

const BANK_LABEL: Record<(typeof BANK_OPTIONS)[number], string> = {
  swedbank: 'Swedbank',
  seb: 'SEB',
  handelsbanken: 'Handelsbanken',
  nordea: 'Nordea',
}

export function SalarySettingsContent() {
  const t = useTranslations('settings_salary')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const tSalary = useTranslations('salary')
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  // Controlled so the LB sunset note reacts to the selection before save.
  const [format, setFormat] = useState<'bg_lb' | 'pain001' | null>(null)
  // Controlled: the Radix Switch is not a form element, so its value rides
  // along in handleSave instead of FormData.
  const [netRounding, setNetRounding] = useState<boolean | null>(null)

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  const effectiveFormat = format ?? settings.preferred_payment_format ?? 'pain001'
  const effectiveNetRounding = netRounding ?? settings.salary_net_rounding ?? false
  const currentSeries = resolveDefaultSeriesForSource(settings, 'salary_payment')

  function handleSave(formData: FormData) {
    const payDayRaw = parseInt((formData.get('salary_pay_day') as string) || '25', 10)
    const payDay = Number.isFinite(payDayRaw) ? Math.min(28, Math.max(1, payDayRaw)) : 25
    const paymentFormat = (formData.get('preferred_payment_format') as string) || 'pain001'
    const bank = (formData.get('salary_default_bank') as string) || 'none'
    const series = (formData.get('salary_voucher_series') as string) || 'A'

    const updates: Record<string, unknown> = {
      salary_pay_day: payDay,
      preferred_payment_format: paymentFormat,
      salary_default_bank: bank === 'none' ? null : bank,
      salary_net_rounding: effectiveNetRounding,
    }

    // The booking engine resolves the series from the per-source-type map;
    // salary entries pass run.voucher_series explicitly, seeded from this
    // entry at run creation. Merge, never replace, the map so other
    // source-type overrides survive.
    if (series !== currentSeries) {
      updates.default_voucher_series_per_source_type = {
        ...(settings?.default_voucher_series_per_source_type || {}),
        salary_payment: series,
      }
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
      <SettingsSectionHeader title={tNav('salary')} intro={tIntro('salary')} />

      <SettingsFormWrapper onSave={handleSave}>
        <SettingsGroup label={t('payments_heading')} help={t('info_payroll_scope')}>
          <SettingsRow
            label={t('pay_day_label')}
            htmlFor="salary_pay_day"
            help={t('pay_day_help')}
            align="baseline"
          >
            <SettingsInput
              id="salary_pay_day"
              name="salary_pay_day"
              type="number"
              inputMode="numeric"
              min={1}
              max={28}
              defaultValue={settings.salary_pay_day ?? 25}
              className="max-w-24 flex-none tabular-nums"
            />
          </SettingsRow>
          <SettingsRow
            label={t('format_label')}
            htmlFor="preferred_payment_format"
            help={t('format_help')}
            borderless={effectiveFormat === 'bg_lb'}
          >
            <SettingsSelect
              id="preferred_payment_format"
              name="preferred_payment_format"
              value={effectiveFormat}
              onChange={(e) => setFormat(e.target.value as 'bg_lb' | 'pain001')}
            >
              <option value="pain001">{t('format_pain001')}</option>
              <option value="bg_lb">{t('format_bg_lb')}</option>
            </SettingsSelect>
          </SettingsRow>
          {effectiveFormat === 'bg_lb' && (
            <p className="border-b border-border px-1 pb-3 text-[12.5px] leading-relaxed text-attn">
              {t('sunset_warning')}
            </p>
          )}
          <SettingsRow label={t('bank_label')} htmlFor="salary_default_bank" help={t('bank_help')}>
            <SettingsSelect
              id="salary_default_bank"
              name="salary_default_bank"
              defaultValue={settings.salary_default_bank ?? 'none'}
            >
              <option value="none">{t('bank_none')}</option>
              {BANK_OPTIONS.map((key) => (
                <option key={key} value={key}>{BANK_LABEL[key]}</option>
              ))}
              <option value="other">{t('bank_other')}</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('net_rounding_label')} help={t('net_rounding_help')}>
            <Switch
              id="salary_net_rounding"
              checked={effectiveNetRounding}
              onCheckedChange={(next) => setNetRounding(next)}
            />
            <label htmlFor="salary_net_rounding" className="cursor-pointer text-sm">
              {t('net_rounding_toggle')}
            </label>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup label={t('accounting_heading')}>
          <SettingsRow
            label={t('voucher_series_label')}
            htmlFor="salary_voucher_series"
            help={t('voucher_series_help')}
          >
            <SettingsSelect
              id="salary_voucher_series"
              name="salary_voucher_series"
              defaultValue={currentSeries}
              className="font-mono"
            >
              {SERIES_OPTIONS.map((letter) => (
                <option key={letter} value={letter}>{letter}</option>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsFormWrapper>

      {/* Tax tables: automatic, read-only status. Lives outside the form so
          the recheck action never interacts with the save flow. */}
      <SettingsGroup
        label={t('tax_tables_heading')}
        help={t.rich('info_current_year', {
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      >
        <SettingsRow label={tSalary('th_status')} help={t('tax_tables_help')}>
          <TaxTableStatus />
        </SettingsRow>
      </SettingsGroup>

      {/* Vacation is configured per employee; this row only points there. */}
      <SettingsGroup label={t('vacation_heading')}>
        <SettingsRow label={t('vacation_rule_label')} help={t('vacation_info')}>
          <Link
            href="/salary/employees"
            className="text-sm text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
          >
            {t('vacation_info_link')}
          </Link>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
