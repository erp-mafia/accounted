'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { SettingsGroup, SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { CashAccount } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// Sentinel for "no override" in the <select>: an empty option value renders
// as the placeholder in some browsers, so use an explicit token instead.
const FOLLOW_DEFAULT = '__default__'

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
 * Labels are bookkeeping-domain terms that stay Swedish across locales, same
 * convention as VoucherSeriesPerSourceTypeForm.
 */
export function VoucherSeriesPerCashAccountForm() {
  const { toast } = useToast()
  const { cashAccounts, isLoading, refresh } = useCashAccounts({ enabledOnly: true })
  const [savingId, setSavingId] = useState<string | null>(null)

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
          title: 'Kunde inte spara',
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      await refresh()
      toast({
        title: 'Verifikationsserie sparad',
        description: next
          ? `Nya verifikat från ${accountLabel(account)} hamnar i serie ${next}.`
          : `${accountLabel(account)} följer nu standardserien för banktransaktioner.`,
      })
    } catch (err) {
      toast({
        title: 'Kunde inte spara',
        description: getErrorMessage(err, { context: 'settings' }),
        variant: 'destructive',
      })
    } finally {
      setSavingId(null)
    }
  }

  return (
    <SettingsGroup
      label="Verifikationsserier per bankkonto"
      help="Låt ett bankkonto bokföra i en egen serie, till exempel huvudbanken på A och företagskortet på M. Tomt fält följer serien för banktransaktioner ovan. Gäller bokföring av banktransaktioner; fakturamatchningar behåller sin betalningsserie."
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Hämtar bankkonton
        </div>
      ) : cashAccounts.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          Inga aktiva bankkonton ännu. Konton skapas när du kopplar en bank eller importerar transaktioner.
        </p>
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
              <option value={FOLLOW_DEFAULT}>Standard</option>
              {SERIES_OPTIONS.map((letter) => (
                <option key={letter} value={letter}>
                  {letter}
                </option>
              ))}
            </SettingsSelect>
          </SettingsRow>
        ))
      )}
    </SettingsGroup>
  )
}
