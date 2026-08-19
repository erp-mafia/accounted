'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { PeriodLockingSettings } from '@/components/settings/PeriodLockingSettings'
import { FiscalYearsManager } from '@/components/settings/FiscalYearsManager'
import { VoucherSeriesManager } from '@/components/settings/VoucherSeriesManager'
import { VoucherSeriesPerSourceTypeForm } from '@/components/settings/VoucherSeriesPerSourceTypeForm'
import { applyDefaultSeriesToMap } from '@/lib/bookkeeping/voucher-series-resolver'
import { DimensionsToggle } from '@/components/settings/DimensionsToggle'
import { MileageToggle } from '@/components/settings/MileageToggle'
import { AccountingFrameworkForm } from '@/components/settings/AccountingFrameworkForm'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { useCompany } from '@/contexts/CompanyContext'
import { ExternalLink } from 'lucide-react'
import type { AccountingFramework, CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function BookkeepingSettingsContent() {
  const t = useTranslations('settings_bookkeeping')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const { company } = useCompany()
  // Local mirror of the company-level accounting_framework so the K2/K3
  // selector can reflect its own saves without waiting for the layout to
  // re-render through the server. Falls back to k2 (matches the column
  // default) until the company row is loaded.
  const [framework, setFramework] = useState<AccountingFramework>(
    company?.accounting_framework ?? 'k2',
  )

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const autoLockValue = formData.get('auto_lock_period_days') as string
    const lockedThrough = (formData.get('bookkeeping_locked_through') as string) || null
    const accountingMethod = (formData.get('accounting_method') as string) || 'accrual'
    const defaultVoucherSeries = (formData.get('default_voucher_series') as string) || 'A'
    // Deferred booking is an accrual-only concept (#967): normalize to false
    // under kontantmetoden so switching back to accrual can never re-activate
    // a stale flag the user set in a mode where it had no effect.
    const deferInvoiceBooking =
      accountingMethod === 'accrual' && formData.get('defer_invoice_booking') === 'true'

    const updates: Record<string, unknown> = {
      bookkeeping_locked_through: lockedThrough,
      auto_lock_period_days: autoLockValue === 'none' ? null : parseInt(autoLockValue),
      accounting_method: accountingMethod,
      default_voucher_series: defaultVoucherSeries,
      defer_invoice_booking: deferInvoiceBooking,
    }

    // Write-through: the booking engine resolves the series from the
    // per-source-type map, NOT from default_voucher_series. So when the user
    // changes the global default, propagate it across the map, but only for
    // types that were still following the previous default, leaving explicit
    // per-type overrides (set via VoucherSeriesPerSourceTypeForm) untouched.
    // Without this the "Standardserie" dropdown is a no-op for bookkeeping.
    // Only runs when the series actually changed, so saving the form for an
    // unrelated reason (e.g. the lock date) never rewrites the map.
    const prevDefault = settings?.default_voucher_series || 'A'
    const currentMap = settings?.default_voucher_series_per_source_type
    if (currentMap && defaultVoucherSeries !== prevDefault) {
      updates.default_voucher_series_per_source_type = applyDefaultSeriesToMap(
        currentMap,
        prevDefault,
        defaultVoucherSeries,
      )
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
    <div>
      <SettingsSectionHeader title={tNav('bookkeeping')} intro={tIntro('bookkeeping')} />

      <SettingsFormWrapper onSave={handleSave}>
        {/* Grunder: framework (AB only), method, deferred booking, default
            series. The framework row saves through its own PATCH and opts out
            of this wrapper's dirty tracking; the rest read via FormData. */}
        <SettingsGroup label={t('group_basics')}>
          {isAktiebolag && (
            <AccountingFrameworkForm
              current={framework}
              onSaved={(next) => setFramework(next)}
            />
          )}
          <SettingsRow
            label={t('method_label')}
            htmlFor="accounting_method"
            help={t('method_help')}
          >
            <SettingsSelect
              id="accounting_method"
              name="accounting_method"
              defaultValue={settings.accounting_method || 'accrual'}
            >
              <option value="accrual">{t('method_accrual')}</option>
              <option value="cash">{t('method_cash')}</option>
            </SettingsSelect>
          </SettingsRow>
          {/* #967: register/send without booking; ekonomi books in a separate
              explicit step. Only meaningful under faktureringsmetoden. */}
          <SettingsRow
            label={t('defer_booking_label')}
            htmlFor="defer_invoice_booking"
            help={t('defer_booking_help')}
          >
            <SettingsSelect
              id="defer_invoice_booking"
              name="defer_invoice_booking"
              defaultValue={settings.defer_invoice_booking ? 'true' : 'false'}
            >
              <option value="false">{t('defer_booking_off')}</option>
              <option value="true">{t('defer_booking_on')}</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow
            label={t('series_label')}
            htmlFor="default_voucher_series"
            help={t('series_help')}
          >
            <SettingsSelect
              id="default_voucher_series"
              name="default_voucher_series"
              defaultValue={settings.default_voucher_series || 'A'}
              className="font-mono"
            >
              {SERIES_OPTIONS.map((letter) => (
                <option key={letter} value={letter}>
                  {letter}
                </option>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>

        <PeriodLockingSettings settings={settings} />
      </SettingsFormWrapper>

      <FiscalYearsManager />

      <VoucherSeriesPerSourceTypeForm
        settings={settings}
        onSettingsUpdated={updateSettings}
      />

      <VoucherSeriesManager defaultSeries={settings.default_voucher_series || 'A'} />

      <SettingsGroup label={t('group_automation')}>
        {/* Periodisering is a review-gated wizard step, not an automation
            that can be switched on or off, so this row is a plain link. The
            old toggle here wrote a localStorage preference nothing read. */}
        <SettingsRow label={t('periodisering_label')} help={t('periodisering_help')}>
          <Link
            href="/bookkeeping/year-end/periodisering"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('periodisering_open_wizard')}
          </Link>
        </SettingsRow>
        <DimensionsToggle />
        <MileageToggle />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t('related_heading')} borderless>
          <Link
            href="/chart-of-accounts"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('related_chart_of_accounts')}
          </Link>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
