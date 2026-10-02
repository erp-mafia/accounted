'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'
import { VacationYearSettings } from '@/components/settings/sections/VacationYearSettings'
import { Switch } from '@/components/ui/switch'
import { useSettings } from '@/components/settings/useSettings'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  DEFAULT_SALARY_CALCULATION_POLICY,
  SALARY_CALCULATION_POLICY_KEYS,
  SALARY_CALCULATION_POLICY_OPTIONS,
  type SalaryCalculationPolicy,
  type SalaryCalculationPolicyKey,
} from '@/lib/salary/calculation-policy'
import type { CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const BANK_OPTIONS = ['swedbank', 'seb', 'handelsbanken', 'nordea'] as const

/**
 * One <select> per calculation convention. The form field name is the policy
 * key prefixed so it cannot collide with a column; the value is validated
 * against the allowed options on save and falls back to the default (the
 * historical engine) for anything unexpected, exactly like the other selects.
 */
function readPolicyFromForm(formData: FormData): SalaryCalculationPolicy {
  const policy = { ...DEFAULT_SALARY_CALCULATION_POLICY } as Record<SalaryCalculationPolicyKey, string>
  for (const key of SALARY_CALCULATION_POLICY_KEYS) {
    const raw = formData.get(`policy_${key}`)
    const options: readonly string[] = SALARY_CALCULATION_POLICY_OPTIONS[key]
    if (typeof raw === 'string' && options.includes(raw)) policy[key] = raw
  }
  return policy as SalaryCalculationPolicy
}

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
  const tTax = useTranslations('settings_tax_form')
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  // Controlled so the LB sunset note reacts to the selection before save.
  const [format, setFormat] = useState<'bg_lb' | 'pain001' | null>(null)
  // Controlled: the Radix Switch is not a form element, so its value rides
  // along in handleSave instead of FormData.
  const [netRounding, setNetRounding] = useState<boolean | null>(null)
  // Payslip sections on the employee's copy (crm#202). Controlled Switches,
  // same null = not touched rule.
  const [showEmployerCost, setShowEmployerCost] = useState<boolean | null>(null)
  const [showBreakdown, setShowBreakdown] = useState<boolean | null>(null)
  // Employer flags moved here from Skatt (2026-09-24). Controlled for the
  // same reason; null = not touched, read the saved value.
  const [paysSalaries, setPaysSalaries] = useState<boolean | null>(null)
  const [employerRegistered, setEmployerRegistered] = useState<boolean | null>(null)
  const [employerSeasonal, setEmployerSeasonal] = useState<boolean | null>(null)

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  const effectiveFormat = format ?? settings.preferred_payment_format ?? 'pain001'
  const effectiveNetRounding = netRounding ?? settings.salary_net_rounding ?? false
  const effectiveShowEmployerCost = showEmployerCost ?? settings.salary_payslip_show_employer_cost ?? true
  const effectiveShowBreakdown = showBreakdown ?? settings.salary_payslip_show_breakdown ?? true
  const effectivePays = paysSalaries ?? settings.pays_salaries ?? false
  // Fall back to pays_salaries for rows saved before the registration flag
  // existed; saving attests the shown value.
  const effectiveRegistered =
    employerRegistered ?? settings.employer_registered ?? settings.pays_salaries ?? false
  const effectiveSeasonal = employerSeasonal ?? settings.employer_seasonal ?? false
  const currentSeries = resolveDefaultSeriesForSource(settings, 'salary_payment')
  // {} on a company that never touched the conventions = every default.
  const currentPolicy: SalaryCalculationPolicy = {
    ...DEFAULT_SALARY_CALCULATION_POLICY,
    ...(settings.salary_calculation_policy ?? {}),
  }

  function handleSave(formData: FormData) {
    const payDayRaw = parseInt((formData.get('salary_pay_day') as string) || '25', 10)
    const payDay = Number.isFinite(payDayRaw) ? Math.min(28, Math.max(1, payDayRaw)) : 25
    const paymentFormat = (formData.get('preferred_payment_format') as string) || 'pain001'
    const bank = (formData.get('salary_default_bank') as string) || 'none'
    const series = (formData.get('salary_voucher_series') as string) || 'A'
    const deviationRaw = formData.get('salary_deviation_period') as string | null
    const deviationPeriod = deviationRaw === 'previous_month' ? 'previous_month' : 'same_month'

    const updates: Record<string, unknown> = {
      salary_pay_day: payDay,
      preferred_payment_format: paymentFormat,
      salary_default_bank: bank === 'none' ? null : bank,
      salary_net_rounding: effectiveNetRounding,
      salary_payslip_show_employer_cost: effectiveShowEmployerCost,
      salary_payslip_show_breakdown: effectiveShowBreakdown,
      salary_deviation_period: deviationPeriod,
      pays_salaries: effectivePays,
      employer_registered: effectiveRegistered,
      employer_seasonal: effectiveRegistered && effectiveSeasonal,
      // All six conventions travel together: the internal settings route
      // stores the object as a whole.
      salary_calculation_policy: readPolicyFromForm(formData),
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
        {/* Whether the company pays salaries at all: drives the AGI
            obligation and whether Löner shows in the menu. Everything below
            folds away while it is off, but stays mounted so saving the
            switch never resets the payroll defaults. */}
        <SettingsGroup>
          <SettingsRow label={tTax('pays_salaries_label')} htmlFor="pays_salaries" help={tTax('pays_salaries_help')}>
            <Switch
              id="pays_salaries"
              checked={effectivePays}
              onCheckedChange={(v) => {
                const checked = v === true
                setPaysSalaries(checked)
                // Paying out salary obliges employer registration (SFL 7 kap. 1 §).
                if (checked) setEmployerRegistered(true)
              }}
            />
            <input type="hidden" name="pays_salaries" value={effectivePays ? 'true' : 'false'} />
          </SettingsRow>
          <SettingsRow
            label={tTax('employer_registered_label')}
            htmlFor="employer_registered"
            help={tTax('employer_registered_help')}
            borderless={effectiveRegistered}
          >
            <Switch
              id="employer_registered"
              checked={effectiveRegistered}
              onCheckedChange={(v) => {
                const checked = v === true
                setEmployerRegistered(checked)
                if (!checked) setEmployerSeasonal(false)
              }}
            />
          </SettingsRow>
          <SettingsReveal open={effectiveRegistered}>
            <SettingsRow
              label={tTax('employer_seasonal_label')}
              htmlFor="employer_seasonal"
              help={tTax('employer_seasonal_help')}
            >
              <Switch
                id="employer_seasonal"
                checked={effectiveSeasonal}
                onCheckedChange={(v) => setEmployerSeasonal(v === true)}
              />
            </SettingsRow>
          </SettingsReveal>
        </SettingsGroup>

        <SettingsReveal open={effectivePays} indent={false}>
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
          <SettingsRow
            label={t('deviation_period_label')}
            htmlFor="salary_deviation_period"
            help={t('deviation_period_help')}
          >
            <SettingsSelect
              id="salary_deviation_period"
              name="salary_deviation_period"
              defaultValue={settings.salary_deviation_period ?? 'same_month'}
            >
              <option value="same_month">{t('deviation_period_same_month')}</option>
              <option value="previous_month">{t('deviation_period_previous_month')}</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('net_rounding_label')} help={t('net_rounding_help')}>
            <Switch
              id="salary_net_rounding"
              aria-label={t('net_rounding_toggle')}
              checked={effectiveNetRounding}
              onCheckedChange={(next) => setNetRounding(next)}
            />
          </SettingsRow>
        </SettingsGroup>

        {/* Calculation conventions (lib/salary/calculation-policy.ts): one
            select per convention, the first option of each being the
            historical engine. Labels and help live under settings_salary as
            policy_<key>_label / _help / _<option>. */}
        <SettingsGroup label={t('policy_heading')} help={t('policy_help')}>
          {SALARY_CALCULATION_POLICY_KEYS.map((key) => (
            <SettingsRow
              key={key}
              label={t(`policy_${key}_label`)}
              htmlFor={`policy_${key}`}
              help={t(`policy_${key}_help`)}
            >
              <SettingsSelect id={`policy_${key}`} name={`policy_${key}`} defaultValue={currentPolicy[key]}>
                {SALARY_CALCULATION_POLICY_OPTIONS[key].map((option) => (
                  <option key={option} value={option}>
                    {t(`policy_${key}_${option}`)}
                  </option>
                ))}
              </SettingsSelect>
            </SettingsRow>
          ))}
        </SettingsGroup>

        {/* What the employee's copy of the payslip prints (crm#202). The
            employer's own view always prints both sections
            (lib/salary/payslips/build-payslip-data). */}
        <SettingsGroup label={t('payslip_heading')} help={t('payslip_help')}>
          <SettingsRow label={t('payslip_employer_cost_label')} help={t('payslip_employer_cost_help')}>
            <Switch
              id="salary_payslip_show_employer_cost"
              aria-label={t('payslip_employer_cost_toggle')}
              checked={effectiveShowEmployerCost}
              onCheckedChange={(next) => setShowEmployerCost(next)}
            />
          </SettingsRow>
          {/* The breakdown's steps carry the employer cost figures, so the
              employee copy prints it only while the employer cost is shown
              (payslipSectionsFor). The stored value is kept as is. */}
          <SettingsRow
            label={t('payslip_breakdown_label')}
            help={effectiveShowEmployerCost ? t('payslip_breakdown_help') : t('payslip_breakdown_requires_employer_cost')}
          >
            <Switch
              id="salary_payslip_show_breakdown"
              aria-label={t('payslip_breakdown_toggle')}
              checked={effectiveShowEmployerCost && effectiveShowBreakdown}
              disabled={!effectiveShowEmployerCost}
              onCheckedChange={(next) => setShowBreakdown(next)}
            />
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
        </SettingsReveal>
      </SettingsFormWrapper>

      {effectivePays ? (
      <>
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

      {/* Semesterår: a choice while the settings service accepts a basis
          change, locked with its reason once open vacation-ledger rows
          exist. Vacation itself is configured per employee; the rule row
          only points there. */}
      <VacationYearSettings settings={settings} onSaved={updateSettings} />
      </>
      ) : null}
    </div>
  )
}
