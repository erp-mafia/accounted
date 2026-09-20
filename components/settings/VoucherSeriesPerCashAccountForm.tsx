'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow, SettingsRowEnd, SettingsSelect } from '@/components/settings/SettingsRows'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { buildVoucherSeriesOptions } from '@/lib/bookkeeping/voucher-series-resolver'
import type { CashAccount, CompanySettings } from '@/types'

// Sentinel for "no override" in the <select>: an empty option value renders
// as the placeholder in some browsers, so use an explicit token instead.
const FOLLOW_DEFAULT = '__default__'

interface Props {
  /** Company settings, for the letters the company has already configured and named. */
  settings: Pick<
    CompanySettings,
    'default_voucher_series' | 'default_voucher_series_per_source_type' | 'voucher_series_labels'
  >
}

/** "Företagskort (1931)" or the bare ledger account when the row has no name. */
function accountLabel(account: CashAccount): string {
  const name = account.name?.trim()
  return name ? `${name} (${account.ledger_account})` : account.ledger_account
}

/**
 * Verifikationsserie per bankkonto. A company that runs several bank accounts
 * (main bank on A, a company-card account on M) can route each account's
 * bookings into its own series. Blank = follow "Verifikationsserier per typ".
 * Saves per row on change, no separate save button: each row is one field on
 * one account, and the bank-transaction booking dialog reads it live.
 *
 * The picker is the same closed list as the manual verifikat form: the fixed
 * Swedish presets plus every letter the company already uses. A free A-Z list
 * would let a typo start an undocumented series (BFNAR 2013:2 p. 9.2-9.15
 * wants the series in use enumerated in the systemdokumentation).
 */
export function VoucherSeriesPerCashAccountForm({ settings }: Props) {
  const t = useTranslations('settings_voucher_series')
  const errorLocale = useLocale() as ErrorLocale
  // Same gate as the server: turning a bank account on or off is owner/admin.
  const { role } = useCompany()
  const canManageAccounts = role === 'owner' || role === 'admin'
  const { toast } = useToast()
  const { cashAccounts, isLoading, refresh } = useCashAccounts({ enabledOnly: true })
  // Same cache, unfiltered: only source to disabled accounts no bank
  // connection holds, which enabledOnly above hides, so a company can turn
  // one back on.
  const { cashAccounts: allCashAccounts } = useCashAccounts()
  const disabledAccounts = useMemo(
    () => allCashAccounts.filter((a) => !a.enabled && a.bank_connection_id === null),
    [allCashAccounts],
  )
  const [savingId, setSavingId] = useState<string | null>(null)

  // Presets first, then any configured or already-assigned letter the presets
  // do not cover, so a Select never renders blank on a value it does not offer.
  // Names come from the company's own voucher_series_labels, presets as fallback.
  const seriesOptions = useMemo(
    () =>
      buildVoucherSeriesOptions(settings.voucher_series_labels, [
        settings.default_voucher_series,
        ...Object.values(settings.default_voucher_series_per_source_type ?? {}),
        ...cashAccounts.map((a) => a.voucher_series),
      ]),
    [
      settings.voucher_series_labels,
      settings.default_voucher_series,
      settings.default_voucher_series_per_source_type,
      cashAccounts,
    ],
  )

  /** PATCH one account's override, then refresh the shared cash-account cache. */
  const handleChange = async (account: CashAccount, value: string) => {
    const next = value === FOLLOW_DEFAULT ? null : value
    if ((account.voucher_series ?? null) === next) return
    setSavingId(account.id)
    try {
      const res = await fetch(`/api/cash-accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voucher_series: next }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('per_account_save_failed'),
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      await refresh()
      toast({
        title: t('per_account_saved_title'),
        description: next
          ? t('per_account_saved_set', { account: accountLabel(account), series: next })
          : t('per_account_saved_cleared', { account: accountLabel(account) }),
      })
    } catch (err) {
      toast({
        title: t('per_account_save_failed'),
        description: getErrorMessage(err, { context: 'settings', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setSavingId(null)
    }
  }

  /**
   * PATCH enabled on/off. Only offered for accounts no bank connection holds
   * (a connection-held one is the AccountPicker's, and the server answers 409
   * for it; same bank_connection_id rule on both sides): the seed migration plants
   * a manual 1930 row on every new company so reconciliation works before any
   * bank is connected, and a company that never connects one, or books its
   * real account on a different ledger slot, needs a way to turn it off.
   */
  const handleToggleEnabled = async (account: CashAccount, next: boolean) => {
    setSavingId(account.id)
    try {
      const res = await fetch(`/api/cash-accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('per_account_save_failed'),
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      await refresh()
      toast({
        title: next ? t('per_account_enabled_title') : t('per_account_disabled_title'),
        description: next
          ? t('per_account_enabled_body', { account: accountLabel(account) })
          : t('per_account_disabled_body', { account: accountLabel(account) }),
      })
    } catch (err) {
      toast({
        title: t('per_account_save_failed'),
        description: getErrorMessage(err, { context: 'settings', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <>
      <SettingsGroup label={t('per_account_heading')} help={t('per_account_help')}>
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('per_account_loading')}
          </div>
        ) : cashAccounts.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">{t('per_account_empty')}</p>
        ) : (
          cashAccounts.map((account, i) => {
            // Mirrors setEnabled()'s own rule: a connection-held account's
            // enabled state belongs to the AccountPicker, and the primary
            // account is never turned off.
            const canDisable = canManageAccounts && account.bank_connection_id === null && !account.is_primary
            return (
              <SettingsRow
                key={account.id}
                label={accountLabel(account)}
                htmlFor={`series-cash-account-${account.id}`}
                borderless={i === cashAccounts.length - 1}
              >
                <SettingsSelect
                  id={`series-cash-account-${account.id}`}
                  value={account.voucher_series ?? FOLLOW_DEFAULT}
                  onChange={(e) => void handleChange(account, e.target.value)}
                  disabled={savingId === account.id}
                  className="font-mono"
                >
                  <option value={FOLLOW_DEFAULT}>{t('per_account_follow_default')}</option>
                  {seriesOptions.map((option) => (
                    <option key={option.letter} value={option.letter}>
                      {option.label ? `${option.letter}  ${option.label}` : option.letter}
                    </option>
                  ))}
                </SettingsSelect>
                {canDisable && (
                  <SettingsRowEnd>
                    <Switch
                      id={`enabled-cash-account-${account.id}`}
                      checked={account.enabled}
                      onCheckedChange={(next) => void handleToggleEnabled(account, next)}
                      disabled={savingId === account.id}
                      aria-label={t('per_account_disable_aria', { account: accountLabel(account) })}
                    />
                    <label
                      htmlFor={`enabled-cash-account-${account.id}`}
                      className="cursor-pointer text-xs text-muted-foreground"
                    >
                      {t('per_account_enabled_label')}
                    </label>
                  </SettingsRowEnd>
                )}
              </SettingsRow>
            )
          })
        )}
      </SettingsGroup>
      {canManageAccounts && disabledAccounts.length > 0 && (
        <SettingsGroup label={t('per_account_disabled_heading')} help={t('per_account_disabled_help')}>
          {disabledAccounts.map((account, i) => (
            <SettingsRow
              key={account.id}
              label={accountLabel(account)}
              borderless={i === disabledAccounts.length - 1}
            >
              <SettingsRowEnd className="ml-0">
                <Switch
                  id={`enabled-disabled-cash-account-${account.id}`}
                  checked={false}
                  onCheckedChange={(next) => void handleToggleEnabled(account, next)}
                  disabled={savingId === account.id}
                  aria-label={t('per_account_enable_aria', { account: accountLabel(account) })}
                />
                <label
                  htmlFor={`enabled-disabled-cash-account-${account.id}`}
                  className="cursor-pointer text-xs text-muted-foreground"
                >
                  {t('per_account_enable_label')}
                </label>
              </SettingsRowEnd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
    </>
  )
}
