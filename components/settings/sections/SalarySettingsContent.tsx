'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { TaxTableStatus } from '@/components/salary/TaxTableStatus'
import { useSettings } from '@/components/settings/useSettings'
import { resolveDefaultSeriesForSource } from '@/lib/bookkeeping/voucher-series-resolver'
import { AlertTriangle } from 'lucide-react'
import type { CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const BANK_OPTIONS = ['swedbank', 'seb', 'handelsbanken', 'nordea'] as const

const BANK_LABEL: Record<(typeof BANK_OPTIONS)[number], string> = {
  swedbank: 'Swedbank',
  seb: 'SEB',
  handelsbanken: 'Handelsbanken',
  nordea: 'Nordea',
}

const selectClassName =
  'flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'

export function SalarySettingsContent() {
  const t = useTranslations('settings_salary')
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  // Controlled so the LB sunset note reacts to the selection before save.
  const [format, setFormat] = useState<'bg_lb' | 'pain001' | null>(null)

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  const effectiveFormat = format ?? settings.preferred_payment_format ?? 'pain001'
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
    }

    // The booking engine resolves the series from the per-source-type map;
    // salary entries pass run.voucher_series explicitly, seeded from this
    // entry at run creation. Merge — never replace — the map so other
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
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        {/* Payment */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('payments_heading')}
          </h2>

          <div className="space-y-2">
            <Label htmlFor="salary_pay_day">{t('pay_day_label')}</Label>
            <Input
              id="salary_pay_day"
              name="salary_pay_day"
              type="number"
              min={1}
              max={28}
              defaultValue={settings.salary_pay_day ?? 25}
              className="w-24 tabular-nums"
            />
            <p className="text-xs text-muted-foreground">{t('pay_day_help')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preferred_payment_format">{t('format_label')}</Label>
            <select
              id="preferred_payment_format"
              name="preferred_payment_format"
              value={effectiveFormat}
              onChange={(e) => setFormat(e.target.value as 'bg_lb' | 'pain001')}
              className={selectClassName}
            >
              <option value="pain001">{t('format_pain001')}</option>
              <option value="bg_lb">{t('format_bg_lb')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('format_help')}</p>
            {effectiveFormat === 'bg_lb' && (
              <div className="flex items-start gap-2 rounded-md border border-border p-3 text-xs max-w-xl">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="text-muted-foreground">
                  {t('sunset_warning')}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="salary_default_bank">{t('bank_label')}</Label>
            <select
              id="salary_default_bank"
              name="salary_default_bank"
              defaultValue={settings.salary_default_bank ?? 'none'}
              className={selectClassName}
            >
              <option value="none">{t('bank_none')}</option>
              {BANK_OPTIONS.map((key) => (
                <option key={key} value={key}>{BANK_LABEL[key]}</option>
              ))}
              <option value="other">{t('bank_other')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('bank_help')}</p>
          </div>
        </section>

        {/* Accounting */}
        <div className="border-t border-border pt-8">
          <section className="space-y-4">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              {t('accounting_heading')}
            </h2>
            <div className="space-y-2">
              <Label htmlFor="salary_voucher_series">{t('voucher_series_label')}</Label>
              <select
                id="salary_voucher_series"
                name="salary_voucher_series"
                defaultValue={currentSeries}
                className="flex h-10 w-16 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {SERIES_OPTIONS.map((letter) => (
                  <option key={letter} value={letter}>{letter}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('voucher_series_help')}</p>
            </div>
          </section>
        </div>
      </SettingsFormWrapper>

      {/* Tax tables (read-only status) */}
      <div className="border-t border-border pt-8">
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('tax_tables_heading')}
          </h2>
          <TaxTableStatus />
          <p className="text-xs text-muted-foreground">{t('tax_tables_help')}</p>
        </section>
      </div>

      {/* Vacation (informational — the rule is per-employee) */}
      <div className="border-t border-border pt-8">
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('vacation_heading')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('vacation_info')}{' '}
            <Link href="/salary/employees" className="underline underline-offset-2 hover:text-foreground">
              {t('vacation_info_link')}
            </Link>
          </p>
        </section>
      </div>

      {/* Info */}
      <div className="border-t border-border pt-8">
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('info_heading')}
          </h2>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>{t('info_payroll_scope')}</p>
            <p>
              {t.rich('info_current_year', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
