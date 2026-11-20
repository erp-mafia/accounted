'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { AttnLine } from '@/components/ui/attn-line'
import { DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAccounts } from '@/lib/reference-data/hooks'
import { ledgerName } from '@/lib/onboarding-books/ledger'
import { cn } from '@/lib/utils'
import { accountDisplayName, isPrivateAccount, ledgerLabel, ledgerLocked, ledgerOptionsFor, selectionBlocker } from '../account-selection'
import type { FlowAction, FlowState } from '../connect-flow-reducer'

interface AccountsStepProps {
  state: FlowState
  dispatch: (action: FlowAction) => void
  onActivate: () => void
  closeButton: React.ReactNode
}

/**
 * Step 3, Konton: the bank's accounts as hairline rows. Company accounts
 * come ticked, private ones unticked with a muted note (the consent view
 * carries no balances; they arrive with the first sync). An
 * account the company booked before keeps its ledger account ("Samma som
 * förut: 1930 Företagskonto"); a new one gets the 19xx picker with the
 * server's suggestion preselected. Aktivera kopplingen runs the first sync.
 */
export function AccountsStep({ state, dispatch, onActivate, closeButton }: AccountsStepProps) {
  const t = useTranslations('bank_connect')
  const { accounts: chart } = useAccounts(true)
  const chartNames = useMemo(() => Object.fromEntries(chart.map((a) => [a.account_number, a.account_name])), [chart])
  const blocker = selectionBlocker(state.accounts, state.selection)

  // The bank signed but listed no account: say so, and leave only Avbryt,
  // which ends the consent. An empty list under Välj minst ett konto was a dead end.
  if (blocker === 'no_accounts') {
    return (
      <div className="space-y-4">
        <AttnLine>{t('no_accounts')}</AttnLine>
        <DialogFooter>{closeButton}</DialogFooter>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('accounts_intro')}</p>

      <ul className="divide-y divide-border border-y border-border">
        {state.accounts.map((account) => {
          const choice = state.selection[account.uid]
          const enabled = Boolean(choice?.enabled)
          const privateAccount = isPrivateAccount(account)
          const name = accountDisplayName(account, t('account_generic'))
          const fallbackName = (ledger: string) => ledgerName(ledger, account.currency, chartNames)
          const id = `bank-connect-account-${account.uid}`
          return (
            <li key={account.uid} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-3">
              <Checkbox id={id} checked={enabled} onCheckedChange={() => dispatch({ type: 'account_toggled', uid: account.uid })} disabled={state.activating} />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className={cn('block truncate text-[13px]', enabled ? 'text-foreground' : 'text-muted-foreground')}>{name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {privateAccount ? t('account_private') : [account.iban ?? account.bban, account.currency !== 'SEK' ? account.currency : null].filter(Boolean).join(', ')}
                </span>
              </label>
              {enabled && (
                // The locked ledger line is a sentence: it takes its own line under
                // the account rather than squeezing the name into "Företa...". The
                // picker is compact and stays at the right from sm up.
                <div className={ledgerLocked(account) && choice?.ledger ? 'basis-full pl-8' : 'basis-full pl-8 sm:basis-auto sm:pl-0'}>
                  {ledgerLocked(account) && choice?.ledger ? (
                    <span className="text-xs text-muted-foreground">{t('ledger_same', { ledger: ledgerLabel(choice.ledger, chart, fallbackName) })}</span>
                  ) : (
                    <Select value={choice?.ledger ?? undefined} onValueChange={(ledger) => dispatch({ type: 'ledger_set', uid: account.uid, ledger })} disabled={state.activating}>
                      <SelectTrigger aria-label={t('ledger_label', { name })} className="h-8 w-[220px] text-[13px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ledgerOptionsFor(account.uid, chart, state.selection, fallbackName).map((option) => (
                          <SelectItem key={option.account_number} value={option.account_number}>
                            <span className="tabular-nums">{option.account_number}</span> {option.account_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {state.activateError ? (
        <AttnLine>{state.activateError}</AttnLine>
      ) : state.activating ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('activating')}
        </p>
      ) : blocker ? (
        <p className="text-xs text-muted-foreground">{t(blocker === 'none_enabled' ? 'no_account_enabled' : 'ledger_missing')}</p>
      ) : null}

      <DialogFooter>
        {closeButton}
        <Button onClick={onActivate} loading={state.activating} disabled={blocker !== null}>
          {t('activate')}
        </Button>
      </DialogFooter>
    </div>
  )
}
