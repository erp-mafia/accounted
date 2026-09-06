'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
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
  const { toast } = useToast()
  const { cashAccounts, isLoading, refresh } = useCashAccounts({ enabledOnly: true })
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
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status }),
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
        description: getErrorMessage(err, { context: 'settings' }),
        variant: 'destructive',
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <SettingsGroup label={t('per_account_heading')} help={t('per_account_help')}>
      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t('per_account_loading')}
        </div>
      ) : cashAccounts.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">{t('per_account_empty')}</p>
      ) : (
        cashAccounts.map((account, i) => (
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
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  )
}
