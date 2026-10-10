'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { AttnLine } from '@/components/ui/attn-line'
import { DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { BankIdChallengeQr } from './BankIdChallengeQr'
import { PAYMENT_ORDER_STATUS_BADGE, PERMANENT_SIGNING_FAILURES } from './payment-order-status'
import {
  bankIdAutostartHref,
  PaymentsClientError,
  pollSigning,
  restartSigning,
  startCompanyVerification,
  startSigning,
  type PaymentOrderStatus,
  type SigningMethod,
  type SigningView,
} from './payments-client'

/** How often the signer's screen asks where the signing stands: the animated QR changes every second. */
const POLL_MS = 1000

/** What the flow needs to show per order: the rest stays on the server. */
export interface SigningOrderSummary {
  id: string
  payee_name: string
  amount: number
  currency: string
}

export type SigningFlowStage = 'method' | 'signing' | 'done'

interface BankIdSigningFlowProps {
  /** Approved orders to sign, all from one account and one currency (the server refuses otherwise). */
  orders: SigningOrderSummary[]
  /** The person has a BankID login on file (availability.signer_known); otherwise a personnummer is typed. */
  signerKnown: boolean
  /** Rendered in the footer next to the flow's own buttons (the dialog's close button). */
  closeButton: React.ReactNode
  /** Called the first time payments were sent to the bank, whatever the bank then answers. */
  onSentToBank?: () => void
  /** Called with every stage change, so a parent can keep its title in step. */
  onStageChange?: (stage: SigningFlowStage) => void
}

/** The signing is over, one way or the other: show where each payment stands. */
export function signingFinished(view: SigningView): boolean {
  return (
    view.status === 'signed' ||
    view.status === 'awaiting_second_signer' ||
    view.status === 'rejected' ||
    view.status === 'cancelled' ||
    view.status === 'failed'
  )
}

/**
 * Signera: one BankID for the selected payments. Three stages:
 *   method:  choose QR or this device (and type a personnummer when none is on file)
 *   signing: the challenge, polled every second; an abandoned signing offers to start again
 *   done:    where each payment stands at the bank
 * The flow never approves anything: it only signs orders that are already
 * approved (Godkänn and Signera are never one button).
 */
export function BankIdSigningFlow({ orders, signerKnown, closeButton, onSentToBank, onStageChange }: BankIdSigningFlowProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [stage, setStageState] = useState<SigningFlowStage>('method')
  const [method, setMethod] = useState<SigningMethod>('qr')
  const [personalNumber, setPersonalNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [signing, setSigning] = useState<SigningView | null>(null)
  const [refusal, setRefusal] = useState<'verification' | 'redirect' | null>(null)
  const sentToBank = useRef(false)

  const setStage = useCallback(
    (next: SigningFlowStage) => {
      setStageState(next)
      onStageChange?.(next)
    },
    [onStageChange],
  )

  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const currency = orders[0]?.currency ?? 'SEK'
  const needsPersonalNumber = !signerKnown
  const typedNumber = personalNumber.trim() || null

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  function applyView(view: SigningView) {
    setSigning(view)
    if (signingFinished(view)) setStage('done')
  }

  async function begin(chosen: SigningMethod) {
    setMethod(chosen)
    setRefusal(null)
    setBusy(true)
    try {
      const view = await startSigning({ orderIds: orders.map((o) => o.id), method: chosen, personalNumber: typedNumber })
      if (!sentToBank.current) {
        sentToBank.current = true
        onSentToBank?.()
      }
      setSigning(view)
      setStage(signingFinished(view) ? 'done' : 'signing')
    } catch (error) {
      const code = error instanceof PaymentsClientError ? error.code : null
      if (code === 'PAYMENT_COMPANY_VERIFICATION_REQUIRED') setRefusal('verification')
      else if (code === 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED') setRefusal('redirect')
      else fail(t('signing_start_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  async function restart(chosen: SigningMethod) {
    if (!signing) return
    setMethod(chosen)
    setBusy(true)
    try {
      applyView(await restartSigning({ batchId: signing.batch_id, method: chosen, personalNumber: typedNumber }))
    } catch (error) {
      fail(t('signing_start_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  async function openVerification() {
    setBusy(true)
    try {
      const { url } = await startCompanyVerification()
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      fail(t('verification_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  // Poll while the person signs. One request at a time (the next is scheduled
  // when the previous answered), aborted and stopped on unmount or when the
  // signing leaves awaiting_signature.
  const batchId = signing?.batch_id ?? null
  const polling = stage === 'signing' && signing?.status === 'awaiting_signature'
  useEffect(() => {
    if (!polling || !batchId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const tick = async () => {
      try {
        const view = await pollSigning({ batchId, personalNumber: typedNumber }, controller.signal)
        if (stopped) return
        setSigning(view)
        if (signingFinished(view)) {
          setStage('done')
          return
        }
        if (view.status !== 'awaiting_signature') return
      } catch {
        // A missed poll (network, a 5xx) is retried on the next tick; an abort ends here.
        if (stopped) return
      }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [polling, batchId, typedNumber, setStage])

  const statusLabel = (status: string) => {
    const key = `status_${status}`
    return t.has(key) ? t(key) : status
  }

  if (stage === 'method') {
    const disabled = busy || orders.length === 0 || (needsPersonalNumber && !typedNumber)
    return (
      <div className="space-y-4">
        <p className="text-[13px] text-muted-foreground">
          {t('sign_summary', { count: orders.length, total: formatCurrency(total, currency) })}
        </p>
        {needsPersonalNumber && (
          <label className="block space-y-2 text-[13px]">
            <span className="text-muted-foreground">{t('personal_number_label')}</span>
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={personalNumber}
              onChange={(e) => setPersonalNumber(e.target.value)}
              placeholder="ÅÅÅÅMMDD-NNNN"
              className="w-[200px] tabular-nums"
            />
          </label>
        )}
        {refusal === 'verification' && (
          <AttnLine action={{ label: t('verify_company'), onClick: openVerification }}>{t('verify_required')}</AttnLine>
        )}
        {refusal === 'redirect' && <AttnLine>{t('signing_redirect_unsupported')}</AttnLine>}
        <DialogFooter>
          {closeButton}
          <Button variant="secondary" onClick={() => begin('same_device')} loading={busy && method === 'same_device'} disabled={disabled}>
            {t('method_same_device')}
          </Button>
          <Button onClick={() => begin('qr')} loading={busy && method === 'qr'} disabled={disabled}>
            {t('method_qr')}
          </Button>
        </DialogFooter>
      </div>
    )
  }

  if (stage === 'signing' && signing) {
    const failure = signing.failure_code
    const permanent = failure ? PERMANENT_SIGNING_FAILURES.has(failure) : false
    const waiting = signing.status === 'awaiting_signature'
    return (
      <div className="space-y-4 text-center">
        {waiting && signing.challenge?.qrData && (
          <>
            <BankIdChallengeQr data={signing.challenge.qrData} label={t('qr_label')} />
            <p className="text-[13px] text-muted-foreground">{t('signing_qr_hint')}</p>
          </>
        )}
        {waiting && !signing.challenge?.qrData && signing.challenge?.autostartToken && (
          <>
            <p className="text-[13px] text-muted-foreground">{t('signing_same_device_hint')}</p>
            <Button asChild>
              <a href={bankIdAutostartHref(signing.challenge.autostartToken)}>{t('open_bankid')}</a>
            </Button>
          </>
        )}
        {waiting && !signing.challenge?.qrData && !signing.challenge?.autostartToken && (
          <p className="text-[13px] text-muted-foreground">{t('signing_waiting')}</p>
        )}
        {!waiting && failure && (
          <div className="space-y-3">
            <AttnLine>
              {failure === 'SCA_REDIRECT_UNSUPPORTED'
                ? t('signing_redirect_unsupported')
                : permanent
                  ? t('signing_failed_permanent', { code: failure })
                  : t('signing_failed')}
            </AttnLine>
            {!permanent && signing.status === 'created' && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onClick={() => restart('same_device')} loading={busy && method === 'same_device'} disabled={busy}>
                  {t('method_same_device')}
                </Button>
                <Button onClick={() => restart('qr')} loading={busy && method === 'qr'} disabled={busy}>
                  {t('try_again')}
                </Button>
              </div>
            )}
          </div>
        )}
        {!waiting && !failure && <p className="text-[13px] text-muted-foreground">{t('signing_waiting')}</p>}
        <DialogFooter>{closeButton}</DialogFooter>
      </div>
    )
  }

  const doneFailure = signing?.failure_code ?? null
  const anyWithBank = (signing?.orders ?? []).some((o) =>
    ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'].includes(o.status),
  )
  return (
    <div className="space-y-4">
      {doneFailure && (
        <AttnLine>
          {doneFailure === 'SCA_REDIRECT_UNSUPPORTED' ? t('signing_redirect_unsupported') : t('signing_failed_permanent', { code: doneFailure })}
        </AttnLine>
      )}
      <ul className="space-y-2 text-[13px]">
        {(signing?.orders ?? []).map((o) => {
          const order = orders.find((p) => p.id === o.id)
          const variant = PAYMENT_ORDER_STATUS_BADGE[o.status as PaymentOrderStatus]
          return (
            <li key={o.id} className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="truncate">{order?.payee_name ?? o.id}</span>
              <span className="flex shrink-0 items-center gap-3">
                {order && <span className="tabular-nums">{formatCurrency(Number(order.amount), order.currency)}</span>}
                {o.outcome_unknown ? (
                  <Badge variant="warning">{t('status_outcome_unknown')}</Badge>
                ) : variant ? (
                  <Badge variant={variant}>{statusLabel(o.status)}</Badge>
                ) : (
                  <span className="text-muted-foreground">{statusLabel(o.status)}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {anyWithBank && (
        <p className="text-[12.5px] text-muted-foreground">
          {signing?.status === 'awaiting_second_signer' ? t('result_second_signer') : t('result_hint')}
        </p>
      )}
      <DialogFooter>{closeButton}</DialogFooter>
    </div>
  )
}
