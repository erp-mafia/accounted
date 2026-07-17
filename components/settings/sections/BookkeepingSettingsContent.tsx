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
import { PeriodiseringAutoDetectToggle } from '@/components/settings/PeriodiseringAutoDetectToggle'
import { DimensionsToggle } from '@/components/settings/DimensionsToggle'
import { AccountingFrameworkForm } from '@/components/settings/AccountingFrameworkForm'
import { useSettings } from '@/components/settings/useSettings'
import { useCompany } from '@/contexts/CompanyContext'
import { Label } from '@/components/ui/label'
import { ExternalLink } from 'lucide-react'
import type { AccountingFramework, CompanySettings } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export function BookkeepingSettingsContent() {
  const t = useTranslations('settings_bookkeeping')
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
    const postingMode =
      (formData.get('posting_mode') as string) === 'workspace_first'
        ? 'workspace_first'
        : 'direct'

    const updates: Record<string, unknown> = {
      bookkeeping_locked_through: lockedThrough,
      auto_lock_period_days: autoLockValue === 'none' ? null : parseInt(autoLockValue),
      accounting_method: accountingMethod,
      default_voucher_series: defaultVoucherSeries,
      defer_invoice_booking: deferInvoiceBooking,
      posting_mode: postingMode,
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
          {/* #967: register/send without booking; ekonomi books in a separate
              explicit step. Only meaningful under faktureringsmetoden. */}
          <div className="space-y-2">
            <Label htmlFor="defer_invoice_booking">{t('defer_booking_label')}</Label>
            <select
              id="defer_invoice_booking"
              name="defer_invoice_booking"
              defaultValue={settings.defer_invoice_booking ? 'true' : 'false'}
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="false">{t('defer_booking_off')}</option>
              <option value="true">{t('defer_booking_on')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('defer_booking_help')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="posting_mode">{t('posting_mode_label')}</Label>
            <select
              id="posting_mode"
              name="posting_mode"
              defaultValue={settings.posting_mode || 'direct'}
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="direct">{t('posting_mode_direct')}</option>
              <option value="workspace_first">{t('posting_mode_workspace_first')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {t('posting_mode_help')}
            </p>
          </div>
        </section>

        {/* Default voucher series */}
        <div className="border-t border-border pt-8">
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
        <div className="border-t border-border pt-8">
          <PeriodLockingSettings settings={settings} />
        </div>
      </SettingsFormWrapper>

      {/* Fiscal years */}
      <div className="border-t border-border pt-8">
        <FiscalYearsManager />
      </div>

      {/* Voucher series: per-source-type mapping */}
      <div className="border-t border-border pt-8">
        <VoucherSeriesPerSourceTypeForm
          settings={settings}
          onSettingsUpdated={updateSettings}
        />
      </div>

      {/* Voucher series: read-only display */}
      <div className="border-t border-border pt-8">
        <VoucherSeriesManager defaultSeries={settings.default_voucher_series || 'A'} />
      </div>

      {/* Periodisering auto-detect toggle */}
      <div className="border-t border-border pt-8">
        <PeriodiseringAutoDetectToggle />
      </div>

      {/* Kostnadsställen & projekt (dimensions) toggle */}
      <div className="border-t border-border pt-8">
        <DimensionsToggle />
      </div>

      {/* Cross-links */}
      <div className="border-t border-border pt-8 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('related_heading')}
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            href="/bookkeeping?tab=accounts"
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
