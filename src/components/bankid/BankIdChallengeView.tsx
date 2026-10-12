'use client'

import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { cn } from '@/lib/utils'
import { BankIdChallengeQr } from './BankIdChallengeQr'
import { bankIdAutostartHref } from './autostart'

export interface BankIdChallengeShape {
  autostartToken: string | null
  qrData: string | null
  qrImage: string | null
}

export interface BankIdChallengeTexts {
  qrLabel: string
  qrHint: string
  sameDeviceHint: string
  openBankId: string
  waiting: string
  /** "Ny QR-kod: skanna igen." when a new QR replaced a scanned one. */
  newQr: string
  secondsLeft: (seconds: number) => string
  maybeExpired: string
}

interface BankIdChallengeViewProps {
  challenge: BankIdChallengeShape | null
  /** The bank's step heading ("Steg 1: identifiera dig"), when the bank says which. */
  stepHeading?: string | null
  /** A new QR replaced one already scanned: the attention line and a stronger frame. */
  newQr?: boolean
  /** Seconds left on the QR, from useQrCountdown; null hides the countdown. */
  secondsLeft?: number | null
  texts: BankIdChallengeTexts
}

/**
 * One BankID challenge as the bank hands it over: the animated QR (data to
 * draw, or a finished image), the same-device button, or the waiting line
 * when the bank sends neither. Shared by the payment signing and the bank
 * reading consent; the parent polls and re-renders it about once a second.
 * The payload is drawn, never logged.
 */
export function BankIdChallengeView({ challenge, stepHeading = null, newQr = false, secondsLeft = null, texts }: BankIdChallengeViewProps) {
  const qrFooter = (
    <>
      <p className="text-[13px] text-muted-foreground">{texts.qrHint}</p>
      {secondsLeft !== null && (
        <p className={cn('text-[12.5px] tabular-nums', secondsLeft > 0 ? 'text-muted-foreground' : 'text-foreground')}>
          {secondsLeft > 0 ? texts.secondsLeft(secondsLeft) : texts.maybeExpired}
        </p>
      )}
    </>
  )
  return (
    <div className="space-y-4 text-center">
      {stepHeading && (
        <div className="space-y-1">
          <p className="text-[13px] font-medium">{stepHeading}</p>
          {newQr && <AttnLine className="text-center">{texts.newQr}</AttnLine>}
        </div>
      )}
      {challenge?.qrData && (
        <>
          <BankIdChallengeQr data={challenge.qrData} label={texts.qrLabel} />
          {qrFooter}
        </>
      )}
      {!challenge?.qrData && challenge?.qrImage && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={challenge.qrImage}
            alt={texts.qrLabel}
            className={cn('mx-auto h-[200px] w-[200px] rounded-lg border bg-white p-1', newQr ? 'border-foreground' : 'border-border')}
          />
          {qrFooter}
        </>
      )}
      {!challenge?.qrData && !challenge?.qrImage && challenge?.autostartToken && (
        <>
          <p className="text-[13px] text-muted-foreground">{texts.sameDeviceHint}</p>
          <Button asChild>
            <a href={bankIdAutostartHref(challenge.autostartToken)}>{texts.openBankId}</a>
          </Button>
        </>
      )}
      {!challenge?.qrData && !challenge?.qrImage && !challenge?.autostartToken && <p className="text-[13px] text-muted-foreground">{texts.waiting}</p>}
    </div>
  )
}
