'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { DialogFooter } from '@/components/ui/dialog'
import { SettingsSeg } from '@/components/settings/SettingsRows'
import { BankList, OpenPaymentsBankMark } from '../BankList'
import { bankReached } from '@/lib/bank-feed/bank-coverage'
import { bankGuideUrl, bankPrerequisiteKey, bankRequiresOffice } from '../bank-help'
import { bankDetailsSettled, officeChoiceMissing, type FlowAction, type FlowState } from '../connect-flow-reducer'
import type { AccountContext, OpenPaymentsBank } from '../open-payments-client'
import { AffiliatePicker } from './AffiliatePicker'
import { LoadError } from '@/components/ui/empty-state'

interface BankPickStepProps {
  state: FlowState
  dispatch: (action: FlowAction) => void
  banks: OpenPaymentsBank[] | null
  banksFailed: boolean
  /** Ask for the bank list again; with it, a failed list offers "Försök igen" in place. */
  onRetryBanks?: () => void
  /** Enskild firma: the private account used in the business is a choice. */
  soleTrader: boolean
  onContinue: () => void
  /** Close the flow and open the earlier bank connection; absent where there is none to open. */
  onEarlierConnection?: () => void
  closeButton: React.ReactNode
}

/**
 * Step 1, Bank: the searchable list (or the locked bank of the connection
 * being replaced) and the account-type toggle for an enskild firma. The
 * explanations (how it goes at the bank, who should hold the phone, the
 * provider) sit behind the title's "?"; the one thing left in the flow is the
 * prerequisite that prevents a failed BankID at the chosen bank, as the
 * step's attention line, plus the bank's one-minute film when we have one.
 * When the chosen bank's details carry sparbanker (SWEDSESS), the picker
 * "Vilken sparbank?" follows the list, or "Vilket kontor?" for a bank that
 * needs one of its offices chosen; the choice travels as the party's
 * affiliated_aspsp_id and names the connection.
 */
export function BankPickStep({ state, dispatch, banks, banksFailed, onRetryBanks, soleTrader, onContinue, onEarlierConnection, closeButton }: BankPickStepProps) {
  const t = useTranslations('bank_connect')
  const chosen = state.bank ? (banks?.find((b) => b.bic === state.bank?.bic) ?? null) : null
  const bankName = state.bank?.name ?? chosen?.name ?? ''
  const prerequisite = state.bank ? bankPrerequisiteKey({ name: bankName, bic: state.bank.bic }) : null
  const guideUrl = state.bank ? bankGuideUrl(state.bank) : null
  // A bank the provider lists but does not reach yet (lib/bank-feed/bank-coverage.ts)
  // is said so before a BankID that would end at the bank's refusal, with the
  // way to the earlier connection that still reads it. The server's answer
  // for this company decides when the list carried one (a pilot company).
  const notReached = state.bank !== null && bankName !== '' && !bankReached(bankName, chosen?.reached)
  // Continue waits for the bank's details: until they answer nobody knows
  // whether the bank has offices to choose among, and a start without one is
  // refused by a bank that needs it (for #208).
  // A bank that needs one of its offices waits for that choice too (for #158).
  const canContinue = state.bank !== null && state.bank.bic !== '' && !notReached && bankDetailsSettled(state) && !officeChoiceMissing(state)
  const affiliates = state.bankDetails?.affiliates ?? []
  const officeRequired = state.bank !== null && bankRequiresOffice(state.bank)

  return (
    <div className="space-y-4">
      {state.bankLocked && state.bank ? (
        <div className="flex items-center gap-3 border-y border-border px-1 py-3">
          <OpenPaymentsBankMark bank={{ name: state.bank.name, logo_url: chosen?.logo_url ?? null }} />
          <span className="min-w-0 flex-1 truncate text-[13px]">{state.bank.name}</span>
        </div>
      ) : banksFailed && onRetryBanks ? (
        // Said where the list would be, with the way to ask again (Stil v3
        // states), instead of "close and try again".
        <LoadError title={t('bank_load_failed_title')} onRetry={onRetryBanks} />
      ) : banksFailed ? (
        <p role="alert" className="px-1 text-xs leading-relaxed text-destructive">
          {t('bank_load_failed')}
        </p>
      ) : (
        <BankList
          banks={banks}
          selectedBic={state.bank?.bic ?? null}
          onPick={(bank) => dispatch({ type: 'bank_picked', bank: { bic: bank.bic, name: bank.name, decoupled: bank.decoupled, redirect: bank.redirect } })}
        />
      )}

      {affiliates.length > 0 && state.bankDetails && (
        <AffiliatePicker
          parentName={state.bankDetails.name}
          officeRequired={officeRequired}
          affiliates={affiliates}
          value={state.affiliate}
          onChange={(affiliate) => dispatch({ type: 'affiliate_picked', affiliate })}
        />
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

      {notReached ? (
        <AttnLine className="px-1" action={onEarlierConnection ? { label: t('not_reached_action'), onClick: onEarlierConnection } : undefined}>
          {t('not_reached', { bank: bankName })}
        </AttnLine>
      ) : (
        prerequisite && <AttnLine className="px-1">{t(`help_${prerequisite}`)}</AttnLine>
      )}

      {guideUrl && (
        <p className="px-1 text-xs">
          <a href={guideUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground">
            {t('guide_link', { bank: bankName })}
          </a>
        </p>
      )}

      <DialogFooter>
        {closeButton}
        <Button onClick={onContinue} disabled={!canContinue}>
          {t('continue')}
        </Button>
      </DialogFooter>
    </div>
  )
}
