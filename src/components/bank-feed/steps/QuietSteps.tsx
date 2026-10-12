'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { useFormat } from '@/lib/hooks/use-format'
import type { FlowState } from '../connect-flow-reducer'

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
  busy: 'verify' | 'mail' | null
  onVerifyNow: () => void
  onSendToSignatory: () => void
  onSkip: () => void
}

/**
 * Step 4, Betalningar: the one offer after the consent, never forced. Verify
 * now opens the provider's form in a new tab and the dialog polls the status
 * while open; Skicka till firmatecknare hands the link over by mail. What
 * the verification is and how the buttons work sits behind the title's "?".
 */
export function PaymentsStep({ state, busy, onVerifyNow, onSendToSignatory, onSkip }: PaymentsStepProps) {
  const t = useTranslations('bank_connect')
  const { formatDateLong } = useFormat()
  const verified = state.verification === 'valid'
  const syncLine = firstSyncLine(state, t)
  return (
    <div className="space-y-4">
      {syncLine && <p className="text-[12.5px] text-muted-foreground">{syncLine}</p>}
      <div className="space-y-2 rounded-lg border border-border p-6">
        <p className="text-[13px] leading-relaxed">{t('payments_title')}</p>
        {verified ? (
          <p className="text-[12.5px]">{state.verificationUntil ? t('verification_valid', { date: formatDateLong(state.verificationUntil) }) : t('verification_valid_no_date')}</p>
        ) : state.verificationUrl ? (
          <p role="status" className="text-[12.5px] text-muted-foreground">
            {t('verification_open')}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" className="text-muted-foreground" onClick={onSkip}>
          {verified ? t('continue') : t('skip')}
        </Button>
        {!verified && (
          <>
            <Button variant="secondary" onClick={onSendToSignatory} loading={busy === 'mail'} disabled={busy !== null}>
              {t('send_to_signatory')}
            </Button>
            <Button onClick={onVerifyNow} loading={busy === 'verify'} disabled={busy !== null}>
              {t('verify_now')}
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
  const paymentsLine = !paymentsAvailable
    ? null
    : state.verification === 'valid'
      ? state.verificationUntil
        ? t('done_payments_verified', { date: formatDateLong(state.verificationUntil) })
        : t('verification_valid_no_date')
      : state.verificationUrl
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
