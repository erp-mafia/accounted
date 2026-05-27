'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { PeriodLockingSettings } from '@/components/settings/PeriodLockingSettings'
import { VoucherSeriesManager } from '@/components/settings/VoucherSeriesManager'
import { VoucherSeriesPerSourceTypeForm } from '@/components/settings/VoucherSeriesPerSourceTypeForm'
import { PeriodiseringAutoDetectToggle } from '@/components/settings/PeriodiseringAutoDetectToggle'
import { AccountingFrameworkForm } from '@/components/settings/AccountingFrameworkForm'
import { useSettings } from '@/components/settings/useSettings'
import { useCompany } from '@/contexts/CompanyContext'
import { Label } from '@/components/ui/label'
import { ExternalLink } from 'lucide-react'
import type { AccountingFramework, CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function BookkeepingSettingsPage() {
  const t = useTranslations('settings_bookkeeping')
  const { settings, isLoading, updateSettings } = useSettings()
  const { company } = useCompany()
  // Local mirror of the company-level accounting_framework so the K2/K3
  // selector can reflect its own saves without waiting for the layout to
  // re-render through the server. Falls back to k2 (matches the column
  // default) until the company row is loaded.
  const [framework, setFramework] = useState<AccountingFramework>(
    company?.accounting_framework ?? 'k2',
  )

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const autoLockValue = formData.get('auto_lock_period_days') as string
    const lockedThrough = (formData.get('bookkeeping_locked_through') as string) || null
    const accountingMethod = (formData.get('accounting_method') as string) || 'accrual'
    const defaultVoucherSeries = (formData.get('default_voucher_series') as string) || 'A'

    const updates: Record<string, unknown> = {
      bookkeeping_locked_through: lockedThrough,
      auto_lock_period_days: autoLockValue === 'none' ? null : parseInt(autoLockValue),
      accounting_method: accountingMethod,
      default_voucher_series: defaultVoucherSeries,
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  // K2/K3 selector is only meaningful for AB. EF stays on EF rules and never
  // picks a framework. Use the company row (source of truth) since
  // company_settings.entity_type can be stale on legacy data.
  const isAktiebolag = company?.entity_type === 'aktiebolag'

  return (
    <div className="space-y-8">
      {isAktiebolag && (
        <AccountingFrameworkForm
          current={framework}
          onSaved={(next) => setFramework(next)}
        />
      )}
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        {/* Accounting method */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('method_heading')}
          </h2>
          <div className="space-y-2">
            <Label htmlFor="accounting_method">{t('method_label')}</Label>
            <select
              id="accounting_method"
              name="accounting_method"
              defaultValue={settings.accounting_method || 'accrual'}
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="accrual">{t('method_accrual')}</option>
              <option value="cash">{t('method_cash')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('method_help')}
            </p>
          </div>
        </section>

        {/* Default voucher series */}
        <div className="border-t border-border/8 pt-8">
          <section className="space-y-4">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              {t('series_heading')}
            </h2>
            <div className="space-y-2">
              <Label htmlFor="default_voucher_series">{t('series_label')}</Label>
              <select
                id="default_voucher_series"
                name="default_voucher_series"
                defaultValue={settings.default_voucher_series || 'A'}
                className="flex h-10 w-16 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {SERIES_OPTIONS.map((letter) => (
                  <option key={letter} value={letter}>{letter}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t('series_help')}
              </p>
            </div>
          </section>
        </div>

        {/* Period locking */}
        <div className="border-t border-border/8 pt-8">
          <PeriodLockingSettings settings={settings} />
        </div>
      </SettingsFormWrapper>

      {/* Voucher series — per-source-type mapping */}
      <div className="border-t border-border/8 pt-8">
        <VoucherSeriesPerSourceTypeForm
          settings={settings}
          onSettingsUpdated={updateSettings}
        />
      </div>

      {/* Voucher series — read-only display */}
      <div className="border-t border-border/8 pt-8">
        <VoucherSeriesManager defaultSeries={settings.default_voucher_series || 'A'} />
      </div>

      {/* Periodisering auto-detect toggle */}
      <div className="border-t border-border/8 pt-8">
        <PeriodiseringAutoDetectToggle />
      </div>

      {/* Cross-links */}
      <div className="border-t border-border/8 pt-8 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('related_heading')}
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('related_fiscal_year')}
          </Link>
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('related_chart_of_accounts')}
          </Link>
        </div>
      </div>
    </div>
  )
}
