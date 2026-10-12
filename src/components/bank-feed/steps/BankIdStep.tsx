'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AttnLine } from '@/components/ui/attn-line'
import { DialogFooter } from '@/components/ui/dialog'
import { BankIdChallengeView } from '@/components/bankid/BankIdChallengeView'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import type { FlowAction, FlowState } from '../connect-flow-reducer'
import type { ConnectMethod } from '../open-payments-client'
import { useBankFeedFailureText } from '../use-bank-feed-failure-text'

interface BankIdStepProps {
  state: FlowState
  dispatch: (action: FlowAction) => void
  /** The person has a BankID login or a remembered personnummer on file: nothing to type. */
  signerKnown: boolean
  /** The typed personnummer was refused when the person tried to start. */
  personalNumberInvalid: boolean
  secondsLeft: number | null
  onStart: (method: ConnectMethod) => void
  onRestart: () => void
  onCopyReminder: () => void
  closeButton: React.ReactNode
}

/**
 * Step 2, BankID: before the start, the BankID mark and (when unknown) the
 * personnummer of the person signing (what to expect sits behind the title's
 * "?"; the title row names the bank with its mark), then the bank's
 * challenge: the animated QR or the same-device button, the bank's step, the
 * new-QR attention line and the 30 s countdown. A refusal shows the bank's
 * text and offers a restart; a consent waiting for a second signatory says
 * so and hands over a link to copy.
 */
export function BankIdStep({ state, dispatch, signerKnown, personalNumberInvalid, secondsLeft, onStart, onRestart, onCopyReminder, closeButton }: BankIdStepProps) {
  const t = useTranslations('bank_connect')
  const failureText = useBankFeedFailureText(state.failure, t('failed_default'))
  // Before the start (never for a resumed connection: the bank already holds it).
  if (state.attempt === null && state.mode !== 'resume') {
    const disabled = state.starting || (!signerKnown && state.personalNumber.trim().length === 0)
    return (
      <div className="space-y-4">
        <BankIdMark className="mx-auto" size={24} />
        {!signerKnown && (
          <label className="block space-y-2 text-[13px]">
            <span className="text-muted-foreground">{t('personal_number_label')}</span>
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={state.personalNumber}
              onChange={(e) => dispatch({ type: 'personal_number_set', value: e.target.value })}
              placeholder="ÅÅÅÅMMDDNNNN"
              aria-invalid={personalNumberInvalid || undefined}
              aria-describedby="bank-connect-pn-hint"
              className="w-[200px] tabular-nums"
            />
            <span id="bank-connect-pn-hint" className={personalNumberInvalid ? 'block text-[12.5px] text-destructive' : 'block text-[12.5px] text-muted-foreground'}>
              {personalNumberInvalid ? t('personal_number_invalid') : t('personal_number_hint')}
            </span>
          </label>
        )}
        {state.startError && <AttnLine>{state.startError}</AttnLine>}
        <DialogFooter>
          {closeButton}
          <Button variant="secondary" onClick={() => onStart('same_device')} loading={state.starting && state.method === 'same_device'} disabled={disabled}>
            {t('method_same_device')}
          </Button>
          <Button onClick={() => onStart('qr')} loading={state.starting && state.method === 'qr'} disabled={disabled}>
            {t('method_qr')}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  const failed = state.pollState === 'failed'
  const partial = state.pollState === 'partially_authorised'
  const stepHeading = state.secondConsent
    ? t('step_second_consent')
    : state.consentStep === 'identify'
      ? t('step_identify')
      : state.consentStep === 'consent'
        ? t('step_consent')
        : null
  const newQr = state.stepsSeen.length > 1

  return (
    <div className="space-y-4">
      {failed ? (
        <div className="space-y-3 text-center">
          {/* One attention line: a restart that failed replaces the bank's earlier refusal. */}
          <AttnLine className="text-center">{state.startError ?? failureText}</AttnLine>
          <Button onClick={onRestart} loading={state.starting}>
            {t('try_again')}
          </Button>
        </div>
      ) : partial ? (
        <div className="space-y-3 text-center">
          <p className="text-[13px] leading-relaxed">{t('partially_authorised')}</p>
          <button type="button" onClick={onCopyReminder} className="text-[12.5px] underline underline-offset-2 hover:opacity-80">
            {t('send_reminder')}
          </button>
        </div>
      ) : state.confirmed ? (
        <p className="text-center text-[13px] text-muted-foreground">{t('activating')}</p>
      ) : (
        <BankIdChallengeView
          challenge={state.attempt?.challenge ?? null}
          stepHeading={stepHeading}
          newQr={newQr}
          secondsLeft={secondsLeft}
          texts={{
            qrLabel: t('qr_label'),
            qrHint: t('qr_hint'),
            sameDeviceHint: t('same_device_hint'),
            openBankId: t('open_bankid'),
            waiting: t('waiting'),
            newQr: t('new_qr'),
            secondsLeft: (seconds) => t('qr_seconds_left', { seconds }),
            maybeExpired: t('qr_maybe_expired'),
          }}
        />
      )}
      <DialogFooter>{closeButton}</DialogFooter>
    </div>
  )
}
