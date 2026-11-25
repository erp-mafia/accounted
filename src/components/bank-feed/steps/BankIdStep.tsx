'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AttnLine } from '@/components/ui/attn-line'
import { DialogFooter } from '@/components/ui/dialog'
import { BankIdChallengeView } from '@/components/bankid/BankIdChallengeView'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { PsuAuthoriserField } from '@/components/bankid/PsuAuthoriserField'
import { leadingSigningMethod, otherSigningMethod, type BankIdSigningWay } from '@/components/payments/signing-method'
import { isPermanentConsentFailure } from '@/lib/bank-feed/failure-text'
import { bankGuideUrl, bankPrerequisiteKey, type SigningApproach } from '../bank-help'
import { consentRefused, redirectInFlight, type FlowAction, type FlowState } from '../connect-flow-reducer'
import type { ConnectMethod } from '../open-payments-client'
import { useBankFeedFailureText } from '../use-bank-feed-failure-text'

interface BankIdStepProps {
  state: FlowState
  dispatch: (action: FlowAction) => void
  /** The person has a BankID login or a remembered personnummer on file: nothing to type. */
  signerKnown: boolean
  /** The typed personnummer was refused when the person tried to start. */
  personalNumberInvalid: boolean
  /** The bank is Nordea: the optional Corporate Netbank logon id goes under the personnummer. */
  asksPsuAuthoriserId: boolean
  /** The typed logon id was refused when the person tried to start. */
  psuAuthoriserIdInvalid: boolean
  secondsLeft: number | null
  /**
   * How the chosen bank signs: its own page only when it signs nowhere else.
   * A bank that also signs in our screen is never offered its page: the
   * consent would be made for that page, and every later call on it (the
   * reads, the revoke) would have to say so, which nothing stores (Swedbank
   * refused such a revoke, 2026-11-12). The server still sends such a bank to
   * its page when the bank itself imposes it on a restart.
   */
  approach: SigningApproach
  /** A phone-sized viewport: BankID on this device leads the ways in, and a second signatory's BankID opens on this device instead of a QR. */
  mobile: boolean
  /** The bank as the person knows it (the sparbank when one is chosen). */
  bankName: string
  onStart: (method: ConnectMethod) => void
  onRestart: () => void
  /** The second signatory of a partially authorised consent starts their own BankID. */
  onSignAsSignatory: (method: ConnectMethod) => void
  /** Leave for the bank's own page (the top window, never a popup). */
  onContinueToBank: (url: string) => void
  /** Copy the link a second signatory opens; absent where no such link exists (the signatory page), and the offer is not shown. */
  onCopyReminder?: () => void
  /** Close the flow and open the bank file import, the way on under a refusal; absent where the entry point offers none, and the line is not shown. */
  onImportFile?: () => void
  closeButton: React.ReactNode
}

/** A quiet link under a refusal, as the bank step draws its guide link. */
const QUIET_LINK = 'text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground'

/**
 * Step 2, BankID: before the start, the BankID mark and (when unknown) the
 * personnummer of the person signing (what to expect sits behind the title's
 * "?"; the title row names the bank with its mark), then the bank's
 * challenge: the animated QR or the same-device button, the bank's step, the
 * new-QR attention line and the 30 s countdown. A bank that signs on its own
 * page gets one line and one button, Fortsätt till {bank}; coming back from
 * it, the step waits for the bank's answer without a QR or a countdown. A
 * refusal shows the bank's text and offers a restart (none when the bank's
 * code names something to fix in the online bank), and under it what to do
 * next: the bank's prerequisite and its guide where we know them (the same
 * two the bank step shows before the BankID) and the way to bank file
 * import; a consent waiting for a
 * second signatory says so and hands over a link to copy. Opened from that
 * link (resume), the second signatory gets the personnummer field and
 * Signera som firmatecknare, which starts their own BankID on the same
 * consent (the bank's partiallyAuthorised: "some but not all mandated
 * authorisations have been performed"). At Nordea an optional Corporate
 * Netbank logon id sits under the personnummer wherever a BankID starts
 * (the second signatory types their own), and beside Försök igen.
 */
export function BankIdStep({
  state,
  dispatch,
  signerKnown,
  personalNumberInvalid,
  asksPsuAuthoriserId,
  psuAuthoriserIdInvalid,
  secondsLeft,
  approach,
  mobile,
  bankName,
  onStart,
  onRestart,
  onSignAsSignatory,
  onContinueToBank,
  onCopyReminder,
  onImportFile,
  closeButton,
}: BankIdStepProps) {
  const t = useTranslations('bank_connect')
  const failureText = useBankFeedFailureText(state.failure, t('failed_default'))
  const personalNumberField = !signerKnown && (
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
      <span id="bank-connect-pn-hint" className={personalNumberInvalid ? 'block text-xs text-destructive' : 'block text-xs text-muted-foreground'}>
        {personalNumberInvalid ? t('personal_number_invalid') : t('personal_number_hint')}
      </span>
    </label>
  )
  const psuAuthoriserField = asksPsuAuthoriserId && (
    <PsuAuthoriserField
      value={state.psuAuthoriserId}
      onChange={(value) => dispatch({ type: 'psu_authoriser_id_set', value })}
      invalid={psuAuthoriserIdInvalid}
      disabled={state.starting}
    />
  )

  // Before the start (never for a resumed connection: the bank already holds it).
  if (state.attempt === null && state.mode !== 'resume') {
    const disabled = state.starting || (!signerKnown && state.personalNumber.trim().length === 0)
    if (approach === 'redirect') {
      return (
        <div className="space-y-4">
          <BankIdMark className="mx-auto" size={24} />
          <p className="text-center text-[13px] leading-relaxed">{t('redirect_intro', { bank: bankName })}</p>
          {personalNumberField}
          {psuAuthoriserField}
          {state.startError && <AttnLine>{state.startError}</AttnLine>}
          <DialogFooter>
            {closeButton}
            <Button onClick={() => onStart('redirect')} loading={state.starting} disabled={disabled}>
              {t('redirect_continue', { bank: bankName })}
            </Button>
          </DialogFooter>
        </div>
      )
    }
    // A phone carries the BankID app and cannot scan its own screen: BankID on
    // this device is the filled button there, and the QR the other one, named
    // for a BankID on another device (the payment signing's rule).
    const leading = leadingSigningMethod({ mobile })
    const other = otherSigningMethod({ mobile })
    const methodLabel = (way: BankIdSigningWay) =>
      way === 'same_device' ? t('method_same_device') : mobile ? t('method_qr_other_device') : t('method_qr')
    return (
      <div className="space-y-4">
        <BankIdMark className="mx-auto" size={24} />
        {personalNumberField}
        {psuAuthoriserField}
        {state.startError && <AttnLine>{state.startError}</AttnLine>}
        {/* The ways in can outgrow one line: let the footer wrap instead of clipping the first button. */}
        <DialogFooter className="sm:flex-wrap">
          {closeButton}
          <Button variant="outline" onClick={() => onStart(other)} loading={state.starting && state.method === other} disabled={disabled}>
            {methodLabel(other)}
          </Button>
          <Button onClick={() => onStart(leading)} loading={state.starting && state.method === leading} disabled={disabled}>
            {methodLabel(leading)}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  const failed = consentRefused(state)
  // What prevents a refusal at this bank, and its guide: said before the
  // BankID on the bank step, and again here where the bank said no.
  const prerequisite = state.bank ? bankPrerequisiteKey(state.bank) : null
  const guideUrl = state.bank ? bankGuideUrl(state.bank) : null
  // The poll gave up (crm#1355): the connection is gone or nothing answers.
  const pollError = state.pollError
  // A refusal the person resolves in the online bank: the text, no Försök igen.
  const permanent = failed && isPermanentConsentFailure(state.failure?.code)
  const partial = state.pollState === 'partially_authorised'
  // The second signatory arrived through the reminder link: they sign here.
  // The first signatory's own screen only says who is still to sign.
  const secondSignatory = partial && state.mode === 'resume'
  // Where the second signatory signs: the bank's page when that is the only
  // way, BankID on this device on a phone, else the QR.
  const signatoryMethod: ConnectMethod = approach === 'redirect' ? 'redirect' : mobile ? 'same_device' : 'qr'
  const signatoryDisabled = state.starting || (!signerKnown && state.personalNumber.trim().length === 0)
  const redirect = redirectInFlight(state)
  const redirectUrl = state.attempt?.challenge?.redirectUrl ?? null
  // Back from the bank's page, or still waiting for its link: nothing to scan, the poll decides.
  const redirectWaiting = redirect && (state.returned?.result === 'ok' || !redirectUrl)
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
      {pollError ? (
        <div className="space-y-3 text-center">
          <AttnLine className="text-center">{pollError.text}</AttnLine>
          {pollError.reason === 'unreachable' ? (
            <Button onClick={() => dispatch({ type: 'poll_retry' })}>{t('try_again')}</Button>
          ) : (
            <Button onClick={() => dispatch({ type: 'start_over' })}>{t('start_over')}</Button>
          )}
        </div>
      ) : failed ? (
        <div className="space-y-3 text-center">
          {/* One attention line: a restart that failed replaces the bank's earlier refusal. */}
          <AttnLine className="text-center">{state.startError ?? failureText}</AttnLine>
          {prerequisite && <p className="text-[13px] leading-relaxed">{t(`help_${prerequisite}`)}</p>}
          {!permanent && psuAuthoriserField && <div className="text-left">{psuAuthoriserField}</div>}
          {!permanent && (
            <Button onClick={onRestart} loading={state.starting}>
              {t('try_again')}
            </Button>
          )}
          {guideUrl && state.bank && (
            <p className="text-xs">
              <a href={guideUrl} target="_blank" rel="noopener noreferrer" className={QUIET_LINK}>
                {t('guide_link', { bank: state.bank.name })}
              </a>
            </p>
          )}
          {onImportFile && (
            <p className="text-xs text-muted-foreground">
              {t.rich('failed_import_file', {
                link: (chunks) => (
                  <button type="button" onClick={onImportFile} className={QUIET_LINK}>
                    {chunks}
                  </button>
                ),
              })}
            </p>
          )}
        </div>
      ) : secondSignatory ? (
        <div className="space-y-4">
          <BankIdMark className="mx-auto" size={24} />
          <p className="text-center text-[13px] leading-relaxed">{t('partially_authorised_sign')}</p>
          {personalNumberField}
          {psuAuthoriserField}
          {state.startError && <AttnLine>{state.startError}</AttnLine>}
          {onCopyReminder && (
            <div className="text-center">
              <button type="button" onClick={onCopyReminder} className="text-xs underline underline-offset-2 hover:opacity-80">
                {t('send_reminder')}
              </button>
            </div>
          )}
        </div>
      ) : partial ? (
        <div className="space-y-3 text-center">
          <p className="text-[13px] leading-relaxed">{t('partially_authorised')}</p>
          {onCopyReminder && (
            <button type="button" onClick={onCopyReminder} className="text-xs underline underline-offset-2 hover:opacity-80">
              {t('send_reminder')}
            </button>
          )}
        </div>
      ) : state.confirmed ? (
        <p className="text-center text-[13px] text-muted-foreground">{t('activating')}</p>
      ) : redirect ? (
        <div className="space-y-4 text-center">
          <BankIdMark className="mx-auto" size={24} />
          <p className={redirectWaiting ? 'text-[13px] text-muted-foreground' : 'text-[13px] leading-relaxed'}>
            {redirectWaiting ? t('redirect_waiting', { bank: bankName }) : t('redirect_intro', { bank: bankName })}
          </p>
        </div>
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
      <DialogFooter>
        {closeButton}
        {secondSignatory && !pollError && (
          <Button onClick={() => onSignAsSignatory(signatoryMethod)} loading={state.starting} disabled={signatoryDisabled}>
            {t('sign_as_signatory')}
          </Button>
        )}
        {redirect && !redirectWaiting && !failed && !pollError && !partial && !state.confirmed && redirectUrl && (
          <Button onClick={() => onContinueToBank(redirectUrl)}>{t('redirect_continue', { bank: bankName })}</Button>
        )}
      </DialogFooter>
    </div>
  )
}
