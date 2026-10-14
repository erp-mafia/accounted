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
import { cn, formatCurrency } from '@/lib/utils'
import { BankIdChallengeQr } from './BankIdChallengeQr'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { BankMark } from '@/components/banks/BankMark'
import { PsuAuthoriserField } from '@/components/bankid/PsuAuthoriserField'
import { normalizePsuAuthoriserId, takesPsuAuthoriserId } from '@/lib/bank-feed/psu-authoriser'
import type { PaymentSigningReturn } from '@/lib/payments/orders/return-url'
import { PAYMENT_ORDER_STATUS_BADGE, PERMANENT_SIGNING_FAILURES } from './payment-order-status'
import { VerificationStateText } from './VerificationStateText'
import {
  bankIdAutostartHref,
  PaymentsClientError,
  pollSigning,
  providerCodeText,
  restartSigning,
  fetchCompanyVerification,
  startCompanyVerification,
  startSigning,
  type CompanyVerification,
  type PaymentOrderStatus,
  type SigningMethod,
  type SigningStep,
  type SigningView,
} from './payments-client'

/** How often the signer's screen asks where the signing stands: the animated QR changes every second. */
const POLL_MS = 1000

/**
 * How long one of the bank's QR codes lives. Swedbank closed a step 33 s
 * after it started it (SIGNING_SESSION_EXPIRED); the countdown is a nudge,
 * the bank's answer decides.
 */
const QR_LIFETIME_S = 30

/** The steps a bank may chain, in the order they come; a bank skips the ones it does not need. */
const STEP_ORDER: SigningStep[] = ['identify', 'approve_payee', 'sign']

/** What the flow needs to show per order: the rest stays on the server. */
export interface SigningOrderSummary {
  id: string
  payee_name: string
  amount: number
  currency: string
}

export type SigningFlowStage = 'method' | 'signing' | 'done'

/**
 * The three calls the flow makes. The session routes by default; the payment
 * signing link's page (/betala/<token>) passes its token routes, which answer
 * the same shapes. `verification` false: the page has no session, so a
 * verification refusal names the problem and offers no form.
 */
export interface SigningClient {
  /** `psuAuthoriserId`: the Nordea Corporate Netbank logon id, when typed (Nordea only; never stored). */
  start(input: { orderIds: string[]; method: SigningMethod; personalNumber: string | null; psuAuthoriserId?: string | null }): Promise<SigningView>
  restart(input: { batchId: string; method: SigningMethod; personalNumber: string | null; psuAuthoriserId?: string | null }): Promise<SigningView>
  poll(input: { batchId: string; personalNumber: string | null; psuAuthoriserId?: string | null }, signal?: AbortSignal): Promise<SigningView>
  verification?: boolean
}

const SESSION_SIGNING_CLIENT: SigningClient = { start: startSigning, restart: restartSigning, poll: pollSigning, verification: true }

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
  /** Start the QR signing at once when the person has a BankID login on file: no method step to click through. */
  autoStart?: boolean
  /** The bank the payments leave from, named with its mark on the signing step. */
  bankName?: string | null
  /**
   * Back from the bank's own page (the redirect method): the signing to pick
   * up at its poll. ok waits for the bank's answer; error shows the bank's
   * code while the poll settles, then offers to try again.
   */
  resume?: PaymentSigningReturn | null
  /** Where the calls go; the session routes when absent. */
  client?: SigningClient
  /**
   * A signing of these orders the bank already holds, unsigned (an abandoned
   * BankID on the payment signing link): the method step signs it again
   * instead of starting a new one.
   */
  pendingBatchId?: string | null
  /** A personnummer typed before the page reloaded (the bank's own page in between). */
  initialPersonalNumber?: string | null
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

/** The view a return from the bank's page starts from: the signing waits, and the first poll tells the truth. */
function resumedView(batchId: string): SigningView {
  return { batch_id: batchId, status: 'awaiting_signature', challenge: null, failure_code: null, step: null, orders: [] }
}

/**
 * Signera: one BankID for the selected payments. Three stages:
 *   method:  choose QR or this device (and type a personnummer when none is on file;
 *            at Nordea, optionally the Corporate Netbank logon id beneath it)
 *   signing: the challenge, polled every second; an abandoned signing offers to start again.
 *            A bank that signs on its own page gets one line and one button,
 *            Fortsätt till {bank}; coming back from it (resume), the stage
 *            waits for the bank's answer without a QR.
 *   done:    where each payment stands at the bank
 * The flow never approves anything: it only signs orders that are already
 * approved (Godkänn and Signera are never one button).
 */
export function BankIdSigningFlow({
  orders,
  signerKnown,
  closeButton,
  onSentToBank,
  onStageChange,
  autoStart = false,
  bankName = null,
  resume = null,
  client = SESSION_SIGNING_CLIENT,
  pendingBatchId = null,
  initialPersonalNumber = null,
}: BankIdSigningFlowProps) {
  const t = useTranslations('bank_payments')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [stage, setStageState] = useState<SigningFlowStage>(resume ? 'signing' : 'method')
  const [method, setMethod] = useState<SigningMethod>(resume ? 'redirect' : 'qr')
  const [personalNumber, setPersonalNumber] = useState(initialPersonalNumber ?? '')
  const [psuAuthoriserId, setPsuAuthoriserId] = useState('')
  const [psuAuthoriserIdInvalid, setPsuAuthoriserIdInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [signing, setSigning] = useState<SigningView | null>(resume ? resumedView(resume.batchId) : null)
  const [refusal, setRefusal] = useState<'verification' | 'redirect' | null>(null)
  /** Where the verification stands when a signing was refused for it: the line names the state and the way out. */
  const [verification, setVerification] = useState<CompanyVerification | null>(null)
  /** The form opened from this refusal, so it can be opened again. */
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null)
  /** Set while the flow was reopened by a return from the bank's own page; cleared by the next start. */
  const [returned, setReturned] = useState<PaymentSigningReturn | null>(resume)
  const sentToBank = useRef(false)
  // The bank's step, when it signs in several: which one, since when, and
  // which ones this signing has been through (a new one means a new QR).
  const [stepSince, setStepSince] = useState<number | null>(null)
  const [stepsSeen, setStepsSeen] = useState<SigningStep[]>([])
  const [now, setNow] = useState(() => Date.now())

  const setStage = useCallback(
    (next: SigningFlowStage) => {
      setStageState(next)
      onStageChange?.(next)
    },
    [onStageChange],
  )

  // A resumed flow opens on the signing stage: the parent's title follows.
  const announcedResume = useRef(false)
  useEffect(() => {
    if (!resume || announcedResume.current) return
    announcedResume.current = true
    onStageChange?.('signing')
  }, [resume, onStageChange])

  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const currency = orders[0]?.currency ?? 'SEK'
  const needsPersonalNumber = !signerKnown
  const typedNumber = personalNumber.trim() || null
  // The paying account's bank is known by name here: Nordea gets the optional
  // Corporate Netbank logon id, sent with each call of this signing, never kept.
  const asksPsuAuthoriserId = takesPsuAuthoriserId({ name: bankName })
  const authoriser = asksPsuAuthoriserId ? normalizePsuAuthoriserId(psuAuthoriserId) : null
  const typedAuthoriser = authoriser?.ok ? authoriser.value : null
  /** A typed logon id the bank could not take: flagged before anything is sent. */
  function authoriserRefused(): boolean {
    const refused = authoriser !== null && !authoriser.ok
    setPsuAuthoriserIdInvalid(refused)
    return refused
  }
  const psuAuthoriserField = asksPsuAuthoriserId && (
    <PsuAuthoriserField value={psuAuthoriserId} onChange={setPsuAuthoriserId} invalid={psuAuthoriserIdInvalid} disabled={busy} />
  )

  const fail = useCallback(
    (title: string, error: unknown) => {
      const body = error instanceof PaymentsClientError ? error.body : null
      toast({ title, description: getErrorMessage(body, { locale }), variant: 'destructive' })
    },
    [locale, toast],
  )

  /**
   * A poll answers where the signing stands; some banks repeat the challenge
   * on every poll (the animated QR), others send it once at the start. A
   * waiting view without a challenge keeps the one on screen.
   */
  function merge(prev: SigningView | null, view: SigningView): SigningView {
    return view.status === 'awaiting_signature' && !view.challenge && prev?.challenge ? { ...view, challenge: prev.challenge } : view
  }

  function applyView(view: SigningView) {
    setSigning((prev) => merge(prev, view))
    if (signingFinished(view)) setStage('done')
  }

  function resetSteps() {
    setStepSince(null)
    setStepsSeen([])
  }

  /** The server decides for a bank that signs only on its own page: the challenge's approach, not the method asked for, is what is on screen. */
  function adoptMethod(chosen: SigningMethod, view: SigningView) {
    setMethod(view.challenge?.approach === 'redirect' ? 'redirect' : chosen)
  }

  async function begin(chosen: SigningMethod) {
    if (authoriserRefused()) return
    setMethod(chosen)
    setRefusal(null)
    setReturned(null)
    resetSteps()
    setBusy(true)
    try {
      const view = pendingBatchId
        ? await client.restart({ batchId: pendingBatchId, method: chosen, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser })
        : await client.start({ orderIds: orders.map((o) => o.id), method: chosen, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser })
      if (!sentToBank.current) {
        sentToBank.current = true
        onSentToBank?.()
      }
      setSigning(view)
      adoptMethod(chosen, view)
      setStage(signingFinished(view) ? 'done' : 'signing')
    } catch (error) {
      const code = error instanceof PaymentsClientError ? error.code : null
      if (code === 'PAYMENT_COMPANY_VERIFICATION_REQUIRED') {
        setRefusal('verification')
        // Best-effort: without the state the line falls back to the plain sentence.
        if (client.verification !== false) fetchCompanyVerification({ refresh: true }).then(setVerification, () => setVerification(null))
      }
      else if (code === 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED') setRefusal('redirect')
      else {
        // The bank's own refusal code, as a sentence when we know it.
        const details = error instanceof PaymentsClientError ? (error.body as { error?: { details?: { provider_code?: string } } } | null)?.error?.details : null
        const known = providerCodeText(t, details?.provider_code)
        if (known) toast({ title: t('signing_start_failed_title'), description: known, variant: 'destructive' })
        else fail(t('signing_start_failed_title'), error)
      }
    } finally {
      setBusy(false)
    }
  }

  async function restart(chosen: SigningMethod) {
    if (!signing) return
    if (authoriserRefused()) return
    setMethod(chosen)
    setReturned(null)
    resetSteps()
    setBusy(true)
    try {
      const view = await client.restart({ batchId: signing.batch_id, method: chosen, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser })
      adoptMethod(chosen, view)
      applyView(view)
    } catch (error) {
      fail(t('signing_start_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  // One automatic start per mount; a failed start lands on the method stage
  // where the person chooses again.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || !signerKnown || autoStarted.current || orders.length === 0) return
    autoStarted.current = true
    void begin('qr')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, signerKnown])

  // The bank's own page replaces this one: the top window goes there (a popup
  // would lose the person on a phone and be blocked on a desktop), and the
  // bank sends it back to Betalningar with the signing named.
  function continueToBank(url: string) {
    window.location.assign(url)
  }

  async function openVerification() {
    if (verificationUrl && verification && (verification.state === 'form_open' || verification.state === 'awaiting_signatory')) {
      window.open(verificationUrl, '_blank', 'noopener,noreferrer')
      return
    }
    setBusy(true)
    try {
      const started = await startCompanyVerification()
      window.open(started.url, '_blank', 'noopener,noreferrer')
      setVerificationUrl(started.url)
      setVerification((current) => ({
        status: current?.status ?? 'unknown',
        valid_until: current?.valid_until ?? null,
        checked_at: current?.checked_at ?? null,
        state: started.state,
        link_expires_at: started.expires_at,
      }))
    } catch (error) {
      fail(t('verification_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  // The refusal's way out follows the state: a form already out is opened
  // again (or waits for the firmatecknare), a lapsed one is renewed, a dead
  // link is replaced. Without a state the first verification is offered.
  const verificationAction = (() => {
    const state = verification?.state ?? 'not_started'
    if (verificationUrl && (state === 'form_open' || state === 'awaiting_signatory')) return { label: t('open_verification_form'), onClick: openVerification }
    // With the firmatecknare: wait for the signature rather than replacing their form.
    if (state === 'awaiting_signatory') return undefined
    if (state === 'link_expired' || state === 'form_open') return { label: t('new_verification_link'), onClick: openVerification }
    if (state === 'expired' || state === 'expiring') return { label: t('renew_company'), onClick: openVerification }
    return { label: t('verify_company'), onClick: openVerification }
  })()

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
        const view = await client.poll({ batchId, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser }, controller.signal)
        if (stopped) return
        setSigning((prev) => merge(prev, view))
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
  }, [polling, batchId, typedNumber, typedAuthoriser, setStage, client])

  // A new step from the bank: note when it began and that it happened.
  const step = signing?.status === 'awaiting_signature' ? (signing.step ?? null) : null
  const stepBatch = signing?.batch_id ?? null
  useEffect(() => {
    if (!step) return
    setStepSince(Date.now())
    setStepsSeen((seen) => (seen.includes(step) ? seen : [...seen, step]))
  }, [step, stepBatch])

  // The countdown ticks while a QR is on screen.
  const counting = stage === 'signing' && signing?.status === 'awaiting_signature' && stepSince !== null
  useEffect(() => {
    if (!counting) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [counting])
  const secondsLeft = stepSince === null ? null : Math.max(0, QR_LIFETIME_S - Math.floor((now - stepSince) / 1000))
  const payeeLabel = orders.length === 1 ? orders[0]!.payee_name : t('several_payees', { count: orders.length })
  const bankLabel = bankName ?? t('bank_fallback_name')

  const statusLabel = (status: string) => {
    const key = `status_${status}`
    return t.has(key) ? t(key) : status
  }
  const bankLine = bankName ? (
    <p className="flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <BankMark bankName={bankName} />
      <span>{t('sign_at_bank', { bank: bankName })}</span>
    </p>
  ) : null

  if (stage === 'method') {
    const disabled = busy || orders.length === 0 || (needsPersonalNumber && !typedNumber)
    return (
      <div className="space-y-4">
        {bankLine}
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
        {psuAuthoriserField}
        {refusal === 'verification' && (
          <AttnLine action={client.verification === false ? undefined : verificationAction}>
            {verification && verification.state !== 'not_started' && verification.state !== 'valid' ? (
              <VerificationStateText verification={verification} />
            ) : (
              t('verify_required')
            )}
          </AttnLine>
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
    const anotherStep = step !== null && stepsSeen.length > 1
    // The bank's own page: the method asked for, or the approach the bank imposed.
    const redirect = method === 'redirect' || signing.challenge?.approach === 'redirect'
    const redirectUrl = signing.challenge?.approach === 'redirect' ? signing.challenge.redirectUrl : null
    // Back from the bank's page, or still waiting for its link: nothing to click, the poll decides.
    const redirectWaiting = redirect && (returned !== null || !redirectUrl)
    const qrFooter = (
      <>
        <p className="text-[13px] text-muted-foreground">{t('signing_qr_hint')}</p>
        {secondsLeft !== null && (
          <p className={cn('text-[12.5px] tabular-nums', secondsLeft > 0 ? 'text-muted-foreground' : 'text-foreground')}>
            {secondsLeft > 0 ? t('qr_seconds_left', { seconds: secondsLeft }) : t('qr_maybe_expired')}
          </p>
        )}
      </>
    )
    return (
      <div className="space-y-4 text-center">
        {waiting && bankLine}
        {waiting && redirect && (
          <div className="space-y-3">
            <BankIdMark className="mx-auto" size={24} />
            <p className={redirectWaiting ? 'text-[13px] text-muted-foreground' : 'text-[13px] leading-relaxed'}>
              {redirectWaiting ? t('redirect_waiting', { bank: bankLabel }) : t('redirect_intro', { bank: bankLabel })}
            </p>
            {returned?.result === 'error' && <AttnLine className="text-center">{providerCodeText(t, returned.code) ?? t('signing_returned_error')}</AttnLine>}
          </div>
        )}
        {waiting && !redirect && step && (
          <div className="space-y-1">
            <p className="text-[13px] text-muted-foreground">{t('steps_intro')}</p>
            <p className="text-[13px] font-medium">
              {t('step_heading', { n: STEP_ORDER.indexOf(step) + 1 })}: {t(`step_${step}`, { payee: payeeLabel })}
            </p>
            {anotherStep && <AttnLine>{t('step_new_qr')}</AttnLine>}
          </div>
        )}
        {waiting && !redirect && signing.challenge?.qrData && (
          <>
            <BankIdChallengeQr data={signing.challenge.qrData} label={t('qr_label')} />
            {qrFooter}
          </>
        )}
        {waiting && !redirect && !signing.challenge?.qrData && signing.challenge?.qrImage && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={signing.challenge.qrImage}
              alt={t('qr_label')}
              className={cn('mx-auto h-[200px] w-[200px] rounded-lg border bg-white p-1', anotherStep ? 'border-foreground' : 'border-border')}
            />
            {qrFooter}
          </>
        )}
        {waiting && !redirect && !signing.challenge?.qrData && !signing.challenge?.qrImage && signing.challenge?.autostartToken && (
          <>
            <p className="text-[13px] text-muted-foreground">{t('signing_same_device_hint')}</p>
            <Button asChild>
              <a href={bankIdAutostartHref(signing.challenge.autostartToken)}>{t('open_bankid')}</a>
            </Button>
          </>
        )}
        {waiting && !redirect && !signing.challenge?.qrData && !signing.challenge?.qrImage && !signing.challenge?.autostartToken && (
          <p className="text-[13px] text-muted-foreground">{t('signing_waiting')}</p>
        )}
        {!waiting && (failure || signing.status === 'created') && (
          <div className="space-y-3">
            <AttnLine>
              {permanent && failure ? (providerCodeText(t, failure) ?? t('signing_failed_permanent', { code: failure })) : (providerCodeText(t, failure) ?? t('signing_failed'))}
            </AttnLine>
            {!permanent && signing.status === 'created' && psuAuthoriserField && <div className="text-left">{psuAuthoriserField}</div>}
            {!permanent && signing.status === 'created' && redirect && (
              <div className="flex justify-center">
                <Button onClick={() => restart('redirect')} loading={busy} disabled={busy}>
                  {t('try_again')}
                </Button>
              </div>
            )}
            {!permanent && signing.status === 'created' && !redirect && (
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
        {!waiting && !failure && signing.status !== 'created' && <p className="text-[13px] text-muted-foreground">{redirect ? t('redirect_waiting', { bank: bankLabel }) : t('signing_waiting')}</p>}
        <DialogFooter>
          {closeButton}
          {waiting && redirect && !redirectWaiting && redirectUrl && <Button onClick={() => continueToBank(redirectUrl)}>{t('redirect_continue', { bank: bankLabel })}</Button>}
        </DialogFooter>
      </div>
    )
  }

  const doneFailure = signing?.failure_code ?? null
  const anyWithBank = (signing?.orders ?? []).some((o) =>
    ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'].includes(o.status),
  )
  return (
    <div className="space-y-4">
      {doneFailure && <AttnLine>{providerCodeText(t, doneFailure) ?? t('signing_failed_permanent', { code: doneFailure })}</AttnLine>}
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
