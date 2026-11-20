'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useAccounts, useCashAccounts } from '@/lib/reference-data/hooks'
import { ledgerName } from '@/lib/onboarding-books/ledger'
import { BankLedgerChangeDialog, type LedgerChangeAsk } from './BankLedgerChangeDialog'
import { ledgerChoices, ledgersHeldElsewhere, syncedAccountsOf, type CashAccountRowLike, type SyncedBankAccount } from './ledger-rows'

interface BankAccountLedgerRowsProps {
  connectionId: string
}

/**
 * The bank accounts one connection syncs, each as its own row under the
 * connection's row with the 19xx account it books on (crm#1387). The account
 * was chosen once, at the first connect, and seven customers asked how to
 * change it: the Open Payments row offered no way at all, and the Enable
 * Banking picker hid it behind the row's menu. Here the account and its
 * ledger account are on the same line, and choosing another one opens the
 * confirmation that says what the change does (BankLedgerChangeDialog).
 * Viewers see the ledger account as a disabled field.
 */
export function BankAccountLedgerRows({ connectionId }: BankAccountLedgerRowsProps) {
  const t = useTranslations('bank_ledger_change')
  const { canWrite } = useCanWrite()
  const { cashAccounts } = useCashAccounts()
  const { accounts: chart } = useAccounts(true)
  const [ask, setAsk] = useState<LedgerChangeAsk | null>(null)

  const rows = cashAccounts as unknown as CashAccountRowLike[]
  const synced = useMemo(() => syncedAccountsOf(connectionId, rows), [connectionId, rows])
  const heldElsewhere = useMemo(() => ledgersHeldElsewhere(connectionId, rows), [connectionId, rows])
  const chartNames = useMemo(() => Object.fromEntries(chart.map((a) => [a.account_number, a.account_name])), [chart])

  if (synced.length === 0) return null

  const label = (account: SyncedBankAccount) =>
    [account.name ?? t('account_generic'), account.ibanLast4 ? `••${account.ibanLast4}` : null].filter(Boolean).join(' ')
  const ledgerLabel = (ledger: string, currency = 'SEK') => `${ledger} ${ledgerName(ledger, currency, chartNames)}`

  return (
    <>
      {synced.map((account) => {
        const choices = ledgerChoices(account.ledger, chart, heldElsewhere, (ledger) => ledgerName(ledger, account.currency, chartNames))
        return (
          <SettingsRow
            key={account.cashAccountId}
            help={t('row_help')}
            label={
              // Indented under the bank's name, past its 28px tile.
              <span className="flex min-w-0 items-center gap-2 pl-10">
                <span data-ph-mask="" className="truncate">{account.name ?? t('account_generic')}</span>
                {account.ibanLast4 && <span data-ph-mask="" className="shrink-0 tabular-nums text-muted-foreground">••{account.ibanLast4}</span>}
              </span>
            }
          >
            <SettingsSelect
              value={account.ledger}
              disabled={!canWrite}
              aria-label={t('select_label', { account: label(account) })}
              onChange={(event) => {
                const toLedger = event.target.value
                if (toLedger && toLedger !== account.ledger) {
                  setAsk({ connectionId, uid: account.uid, label: label(account), toLedger })
                }
              }}
            >
              {choices.map((choice) => (
                <option key={choice.account_number} value={choice.account_number}>
                  {`${choice.account_number} ${choice.account_name}`}
                </option>
              ))}
            </SettingsSelect>
          </SettingsRow>
        )
      })}
      <BankLedgerChangeDialog
        ask={ask}
        ledgerLabel={(ledger) => ledgerLabel(ledger, synced.find((a) => a.uid === ask?.uid)?.currency)}
        onClose={() => setAsk(null)}
      />
    </>
  )
}
