'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { VerificationStateText } from '@/components/payments/VerificationStateText'
import { useFormat } from '@/lib/hooks/use-format'
import { FORM_OUT_STATES, RENEWAL_DUE_STATES, type VerificationState } from '@/lib/payments/orders/verification-state'
import type { FlowState } from '../connect-flow-reducer'
import type { VerificationStartKind } from '../use-bank-connect-controller'

/** Step 0 (switch only): what changes, in three lines (the provider is named behind the title's "?"). */
export function IntroStep({ deadline, onContinue, closeButton }: { deadline: string | null; onContinue: () => void; closeButton: React.ReactNode }) {
  const t = useTranslations('bank_connect')
  const { formatDateLong } = useFormat()
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-[13px] leading-relaxed">
        <li>{t('intro_line_1')}</li>
        <li>{t('intro_line_2')}</li>
        <li>{t('intro_line_3')}</li>
      </ul>
      {deadline && <p className="text-[13px]">{t('intro_deadline', { date: formatDateLong(deadline) })}</p>}
      <DialogFooter>
        {closeButton}
        <Button onClick={onContinue}>{t('continue')}</Button>
      </DialogFooter>
    </div>
  )
}

/** "{n} transaktioner hämtade", or the background line while the first import runs on; null when neither is known. */
function firstSyncLine(state: Pick<FlowState, 'firstSync' | 'syncPending'>, t: ReturnType<typeof useTranslations<'bank_connect'>>): string | null {
  if (state.firstSync) return t('imported', { count: state.firstSync.imported })
  if (state.syncPending) return t('sync_background')
  return null
}

interface PaymentsStepProps {
  state: FlowState
  busy: VerificationStartKind | null
  /** Start (or renew) the verification: a fresh form link opened in a new tab. */
  onVerifyNow: () => void
  /** Open the form again, while this sitting holds its link. */
  onOpenForm?: () => void
  /** Hand the form over by mail; absent where the signatory is the one at the screen (the signatory page). */
  onSendToSignatory?: () => void
  /** Hand the form over as a copied link (for a chat or a text); absent on the signatory page. */
  onCopyForSignatory?: () => void
  onSkip: () => void
}

/** The step's state for the copy and the buttons: what the doors said, or not_started until they answer. */
function verificationOf(state: FlowState): { state: VerificationState; valid_until: string | null; link_expires_at: string | null } {
  return { state: state.verificationState ?? 'not_started', valid_until: state.verificationUntil, link_expires_at: state.verificationLinkExpiresAt }
}

/**
 * Step 4, Betalningar: the one offer after the consent, never forced. The
 * sentence under the title says where the verification stands (not started,
 * form open, with the firmatecknare, link expired, valid, expiring, expired)
 * and the buttons follow it: Verifiera nu / Förnya nu / Skapa ny länk opens a
 * fresh form in a new tab and the dialog polls the status while open; Skicka
 * till firmatecknare and Kopiera länken hand a fresh link over (the state then
 * reads awaiting_signatory). What the verification is and how the buttons
 * work sits behind the title's "?".
 */
export function PaymentsStep({ state, busy, onVerifyNow, onOpenForm, onSendToSignatory, onCopyForSignatory, onSkip }: PaymentsStepProps) {
  const t = useTranslations('bank_connect')
  const verification = verificationOf(state)
  const verified = state.verification === 'valid' && !RENEWAL_DUE_STATES.has(verification.state)
  const renewal = RENEWAL_DUE_STATES.has(verification.state)
  const formOut = FORM_OUT_STATES.has(verification.state)
  const syncLine = firstSyncLine(state, t)
  // A form this sitting opened is opened again; otherwise a fresh link is made.
  const reopen = formOut && onOpenForm !== undefined
  const primaryLabel = reopen
    ? t('open_form')
    : verification.state === 'link_expired' || formOut
      ? t('new_link')
      : renewal
        ? t('renew_now')
        : t('verify_now')
  const primaryAction = reopen ? onOpenForm : onVerifyNow
  return (
    <div className="space-y-4">
      {syncLine && <p className="text-[12.5px] text-muted-foreground">{syncLine}</p>}
      <div className="space-y-2 rounded-lg border border-border p-6">
        <p className="text-[13px] leading-relaxed">{t('payments_title')}</p>
        <p role="status" className={verified ? 'text-[12.5px]' : 'text-[12.5px] text-muted-foreground'}>
          <VerificationStateText verification={verification} />
        </p>
      </div>
      {/* sm:flex-wrap: unverified, the row holds four buttons (~690px) in a
          528px dialog, and the single row pushed Hoppa över off the left edge. */}
      <DialogFooter className="sm:flex-wrap sm:gap-2 sm:space-x-0">
        <Button variant="ghost" className="text-muted-foreground" onClick={onSkip}>
          {verified || verification.state === 'expiring' ? t('continue') : t('skip')}
        </Button>
        {!verified && (
          <>
            {onCopyForSignatory && (
              <Button variant="secondary" onClick={onCopyForSignatory} loading={busy === 'copy'} disabled={busy !== null}>
                {t('copy_link')}
              </Button>
            )}
            {onSendToSignatory && (
              <Button variant="secondary" onClick={onSendToSignatory} loading={busy === 'mail'} disabled={busy !== null}>
                {verification.state === 'awaiting_signatory' ? t('send_again') : t('send_to_signatory')}
              </Button>
            )}
            <Button onClick={primaryAction} loading={busy === 'verify'} disabled={busy !== null}>
              {primaryLabel}
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  )
}

/** Step 5, Klart: what is connected and what happens next, in a few plain lines. */
export function DoneStep({ state, onClose }: { state: FlowState; onClose: () => void }) {
  const t = useTranslations('bank_connect')
  const { formatDateLong } = useFormat()
  const bank = state.connection?.bank_name ?? state.bank?.name ?? ''
  const viewAccounts = state.connection?.accounts ?? []
  const count = viewAccounts.length > 0 ? viewAccounts.filter((a) => a.enabled).length : Object.values(state.selection).filter((c) => c.enabled).length
  const syncLine = firstSyncLine(state, t)
  // Payments are available to the company when a verification status was
  // read at all (the offer itself is shown only while unverified).
  const paymentsAvailable = state.verification !== null || state.paymentsOffered === true
  const verificationState = state.verificationState
  const paymentsLine = !paymentsAvailable
    ? null
    : verificationState === 'awaiting_signatory'
      ? t('done_payments_awaiting')
      : verificationState !== null && RENEWAL_DUE_STATES.has(verificationState)
        ? t('done_payments_renew')
        : state.verification === 'valid'
          ? state.verificationUntil
            ? t('done_payments_verified', { date: formatDateLong(state.verificationUntil) })
            : t('verification_valid_no_date')
          : state.verificationUrl || verificationState === 'form_open'
            ? t('done_payments_pending')
            : t('done_payments_later')
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-[13px] leading-relaxed">
        <li>{t('done_accounts', { bank, count })}</li>
        {syncLine && <li>{syncLine}</li>}
        <li>{t('done_next_sync')}</li>
        {paymentsLine && <li>{paymentsLine}</li>}
        <li className="text-muted-foreground">{t('done_find')}</li>
      </ul>
      <DialogFooter>
        <Button onClick={onClose}>{t('close')}</Button>
      </DialogFooter>
    </div>
  )
}
