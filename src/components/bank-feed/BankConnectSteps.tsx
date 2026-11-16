'use client'

import { useTranslations } from 'next-intl'
import { bankHelpKey, isTwoStepBank } from './bank-help'
import type { FlowState } from './connect-flow-reducer'
import { stepPosition } from './flow-steps'
import type { OpenPaymentsBank } from './open-payments-client'
import type { BankConnectController } from './use-bank-connect-controller'
import type { BankConnectSession } from './use-bank-connect-flow'
import { AccountsStep } from './steps/AccountsStep'
import { BankIdStep } from './steps/BankIdStep'
import { BankPickStep } from './steps/BankPickStep'
import { DoneStep, IntroStep, PaymentsStep } from './steps/QuietSteps'

type Translate = ReturnType<typeof useTranslations<'bank_connect'>>

/** "Steg n av N" for the header, or null on the intro and the finished screen. */
export function flowPosition(state: FlowState): { n: number; total: number } | null {
  return stepPosition(state.step, state.mode, state.paymentsOffered)
}

/** From the BankID step on, the header carries the bank's mark: the person sees whose BankID they are about to answer. */
export function flowShowsBankMark(state: FlowState, bankName: string | null): boolean {
  return bankName !== null && (state.step === 'bankid' || state.step === 'accounts' || state.step === 'payments' || state.step === 'done')
}

/** The header's title: the mode's, the bank's at the BankID step, Klart at the end. `bankName` is the controller's (the sparbank when one is chosen). */
export function flowTitle(state: FlowState, bankName: string | null, t: Translate): string {
  if (state.step === 'intro') return t('title_intro')
  if (state.step === 'done') return t('title_done')
  if (state.step === 'bankid' && bankName) return t('title_bankid', { bank: bankName })
  return t(`title_${state.mode}`)
}

/**
 * What sits behind the title's "?" (design convention 7): every explanation
 * of the step, so the steps themselves carry only the controls, one
 * attention line at most, and the state.
 */
export function FlowHelp({ controller }: { controller: BankConnectController }) {
  const t = useTranslations('bank_connect')
  const { state, approach, redirectHelp, bankName } = controller
  const bankHelp = state.bank ? bankHelpKey(state.bank) : null
  const twoStep = state.bank ? isTwoStepBank(state.bank) : false
  switch (state.step) {
    case 'intro':
      return <p>{t('provider_line')}</p>
    case 'bank':
      return (
        <div className="space-y-2">
          {state.bank && <p>{t('help_generic', { bank: state.bank.name })}</p>}
          {state.bank && bankHelp && !twoStep && <p>{t(`help_${bankHelp}`)}</p>}
          {twoStep && <p>{t('help_svea')}</p>}
          {state.bank && approach === 'redirect' && <p>{t('help_redirect', { bank: bankName ?? state.bank.name })}</p>}
          {state.bankLocked && state.bank && <p>{t(state.mode === 'renew' ? 'bank_locked_renew' : 'bank_locked_switch', { bank: state.bank.name })}</p>}
          <p>{t('bankid_intro')}</p>
          <p>{t('provider_line')}</p>
        </div>
      )
    case 'bankid':
      return (
        <div className="space-y-2">
          {redirectHelp && bankName && <p>{t('help_redirect', { bank: bankName })}</p>}
          <p>{t('bankid_intro')}</p>
          {twoStep && <p>{t('help_svea')}</p>}
        </div>
      )
    case 'accounts':
      return <p>{t('help_accounts')}</p>
    case 'payments':
      return (
        <div className="space-y-2">
          <p>{t('payments_body')}</p>
          <p>{t('help_payments_mechanics')}</p>
        </div>
      )
    default:
      return null
  }
}

interface FlowStepsProps {
  controller: BankConnectController
  session: BankConnectSession
  banks: OpenPaymentsBank[] | null
  banksFailed: boolean
  /** Ask for the bank list again after it failed (BankPickStep's "Försök igen"). */
  onRetryBanks?: () => void
  /** Enskild firma: the private account used in the business is a choice. */
  soleTrader: boolean
  /** The step footers' cancel button; the finished screen shows `onClose` instead. */
  closeButton: React.ReactNode
  onClose: () => void
  /** Close the flow and open the earlier bank connection (Enable Banking), for a bank the new one does not reach yet; absent where there is none to open (the signatory page). */
  onEarlierConnection?: () => void
  /** Copy the link a second signatory opens; absent where no such link exists (the signatory page). */
  onCopyReminder?: () => void
  /** Hand the verification form to a signatory by mail; absent where the signatory is the one at the screen. */
  onSendToSignatory?: () => void
  /** Hand the verification form to a signatory as a copied link; absent where the signatory is the one at the screen. */
  onCopyForSignatory?: () => void
}

/** The step on screen, from the controller's state. The header (title, "?", step count) is the surface's own. */
export function FlowSteps({ controller, session, banks, banksFailed, onRetryBanks, soleTrader, closeButton, onClose, onEarlierConnection, onCopyReminder, onSendToSignatory, onCopyForSignatory }: FlowStepsProps) {
  const { state, dispatch } = controller
  switch (state.step) {
    case 'intro':
      return <IntroStep deadline={session.options.deadline ?? null} onContinue={() => dispatch({ type: 'continue' })} closeButton={closeButton} />
    case 'bank':
      return (
        <BankPickStep
          state={state}
          dispatch={dispatch}
          banks={banks}
          banksFailed={banksFailed}
          onRetryBanks={onRetryBanks}
          soleTrader={soleTrader}
          onContinue={() => dispatch({ type: 'to_bankid' })}
          onEarlierConnection={onEarlierConnection}
          closeButton={closeButton}
        />
      )
    case 'bankid':
      return (
        <BankIdStep
          state={state}
          dispatch={dispatch}
          signerKnown={controller.signerKnown}
          personalNumberInvalid={controller.personalNumberInvalid}
          asksPsuAuthoriserId={controller.asksPsuAuthoriserId}
          psuAuthoriserIdInvalid={controller.psuAuthoriserIdInvalid}
          secondsLeft={controller.secondsLeft}
          approach={controller.approach}
          mobile={controller.mobile}
          bankName={controller.bankName ?? ''}
          onStart={controller.start}
          onRestart={() => void controller.restart()}
          onSignAsSignatory={controller.signAsSignatory}
          onContinueToBank={controller.continueToBank}
          onCopyReminder={onCopyReminder}
          closeButton={closeButton}
        />
      )
    case 'accounts':
      return <AccountsStep state={state} dispatch={dispatch} onActivate={controller.activate} closeButton={closeButton} />
    case 'payments':
      return (
        <PaymentsStep
          state={state}
          busy={controller.paymentsBusy}
          onVerifyNow={() =>
            controller.openVerification('verify', (url) => {
              window.open(url, '_blank', 'noopener,noreferrer')
            })
          }
          onOpenForm={state.verificationUrl ? () => window.open(state.verificationUrl!, '_blank', 'noopener,noreferrer') : undefined}
          onSendToSignatory={onSendToSignatory}
          onCopyForSignatory={onCopyForSignatory}
          onSkip={() => dispatch({ type: 'payments_done' })}
        />
      )
    case 'done':
      return <DoneStep state={state} onClose={onClose} />
    default:
      return null
  }
}
