'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { SettingsSeg } from '@/components/settings/SettingsRows'
import { BankList, OpenPaymentsBankMark } from '../BankList'
import { bankHelpKey } from '../bank-help'
import type { FlowAction, FlowState } from '../connect-flow-reducer'
import type { AccountContext, OpenPaymentsBank } from '../open-payments-client'

interface BankPickStepProps {
  state: FlowState
  dispatch: (action: FlowAction) => void
  banks: OpenPaymentsBank[] | null
  banksFailed: boolean
  /** Enskild firma: the private account used in the business is a choice. */
  soleTrader: boolean
  onContinue: () => void
  closeButton: React.ReactNode
}

/**
 * Step 1, Bank: the searchable list (or the locked bank of the connection
 * being replaced), the account-type toggle for an enskild firma, and what to
 * expect at this bank before the BankID starts. The banks route lists no
 * affiliates, so the sparbank picker waits for a bank-details read; a
 * Swedbank consent reaches the sparbanker through the bank's own prompt.
 */
export function BankPickStep({ state, dispatch, banks, banksFailed, soleTrader, onContinue, closeButton }: BankPickStepProps) {
  const t = useTranslations('bank_connect')
  const chosen = state.bank ? (banks?.find((b) => b.bic === state.bank?.bic) ?? null) : null
  const bankName = state.bank?.name ?? chosen?.name ?? ''
  const helpKey = state.bank ? bankHelpKey({ name: bankName, bic: state.bank.bic }) : null
  const canContinue = state.bank !== null && state.bank.bic !== ''

  return (
    <div className="space-y-4">
      {state.bankLocked && state.bank ? (
        <div className="flex items-center gap-3 border-y border-border px-1 py-3">
          <OpenPaymentsBankMark bank={{ name: state.bank.name, logo_url: chosen?.logo_url ?? null }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">{state.bank.name}</span>
            <span className="block text-[12.5px] text-muted-foreground">
              {t(state.mode === 'renew' ? 'bank_locked_renew' : 'bank_locked_switch', { bank: state.bank.name })}
            </span>
          </span>
        </div>
      ) : banksFailed ? (
        <p role="alert" className="px-1 text-[12.5px] leading-relaxed text-destructive">
          {t('bank_load_failed')}
        </p>
      ) : (
        <BankList banks={banks} selectedBic={state.bank?.bic ?? null} onPick={(bank) => dispatch({ type: 'bank_picked', bank: { bic: bank.bic, name: bank.name } })} />
      )}

      {soleTrader && state.bank && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px]">
          <span className="text-muted-foreground">{t('context_label')}</span>
          <SettingsSeg<AccountContext>
            value={state.context ?? 'corporate'}
            onChange={(context) => dispatch({ type: 'context_set', context })}
            aria-label={t('context_label')}
            options={[
              { value: 'corporate', label: t('context_corporate') },
              { value: 'private', label: t('context_private') },
            ]}
          />
        </div>
      )}

      {state.bank && (
        <div className="space-y-1 px-1 text-[12.5px] leading-relaxed text-muted-foreground">
          <p>{t('help_generic', { bank: bankName })}</p>
          {helpKey && <p>{t(`help_${helpKey}`)}</p>}
        </div>
      )}

      {state.mode !== 'switch' && <p className="px-1 text-[12.5px] leading-relaxed text-muted-foreground">{t('provider_line')}</p>}

      <DialogFooter>
        {closeButton}
        <Button onClick={onContinue} disabled={!canContinue}>
          {t('continue')}
        </Button>
      </DialogFooter>
    </div>
  )
}
