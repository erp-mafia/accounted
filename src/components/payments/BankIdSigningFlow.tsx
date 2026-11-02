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
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency } from '@/lib/utils'
import { BankIdChallengeQr } from './BankIdChallengeQr'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { BankMark } from '@/components/banks/BankMark'
import { PsuAuthoriserField } from '@/components/bankid/PsuAuthoriserField'
import { normalizePsuAuthoriserId, takesPsuAuthoriserId } from '@/lib/bank-feed/psu-authoriser'
import type { PaymentSigningReturn } from '@/lib/payments/orders/return-url'
import { followUpDelayMs, PAYMENT_ORDER_STATUS_BADGE, PERMANENT_SIGNING_FAILURES, signsAnew } from './payment-order-status'
import { VerificationStateText } from './VerificationStateText'
import { verificationStep } from '@/lib/payments/orders/readiness'
import { BankPaymentsAllowanceLine } from './BankPaymentsAllowance'
import { RequestSigningLinkPanel } from './RequestSigningLinkDialog'
import {
  allowanceRefusalOf,
  bankIdAutostartHref,
  fetchBankPaymentsUsage,
  PaymentsClientError,
  pollSigning,
  providerCodeText,
  restartSigning,
  signingOfRefusedStart,
  fetchCompanyVerification,
  startCompanyVerification,
  startSecondSignature,
  startSigning,
  withIncludedPayments,
  withIncludedRefusal,
  type BankPaymentsAllowanceRefusal,
  type BankPaymentsUsage,
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
  /** The other signatory's BankID for a signing the bank holds for them; the poll follows it. */
  secondSignature(input: { batchId: string; method: SigningMethod; personalNumber: string | null; psuAuthoriserId?: string | null }): Promise<SigningView>
  poll(input: { batchId: string; personalNumber: string | null; psuAuthoriserId?: string | null }, signal?: AbortSignal): Promise<SigningView>
  verification?: boolean
  /**
   * A signing link to the other signatory can be sent from here, when the
   * bank waits for them (Skicka en länk). Absent on the link's own page: the
   * firmatecknare there has no login to send one with.
   */
  signingLinks?: boolean
  /**
   * This month's bank payments against the cap, for a session that can read
   * them and ask for more (Begär fler betalningar). Absent on the payment
   * signing link: the firmatecknare has no login, and a refusal at the cap
   * names who can ask instead.
   */
  usage?: () => Promise<BankPaymentsUsage>
}

const SESSION_SIGNING_CLIENT: SigningClient = {
  start: startSigning,
  restart: restartSigning,
  secondSignature: startSecondSignature,
  poll: pollSigning,
  verification: true,
  signingLinks: true,
  usage: () => fetchBankPaymentsUsage(),
}

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
   * A signing of these orders the bank already holds, unsigned, in a signing
   * nobody is in (Signera igen, isSignableAgain): the method step signs it
   * again instead of starting a new one.
   */
  pendingBatchId?: string | null
  /** A personnummer typed before the page reloaded (the bank's own page in between). */
  initialPersonalNumber?: string | null
  /**
   * A signing the bank holds for another signatory, at a bank that takes that
   * signature here: the method step signs it as that signatory, whose
   * personnummer is typed.
   */
  secondSignatureBatchId?: string | null
  /** The result offers Kontrasignera when the bank waits for another signatory here; false where the link that signed is spent. */
  offerSecondSignature?: boolean
  /** Called when a signing link to the other signatory was sent from the flow (Skicka en länk): the parent reloads its list on close. */
  onLinkIssued?: () => void
}

/**
 * The signing is over, one way or the other: show where each payment stands.
 * Not a BankID that ended unsigned whose orders the server let go to be
 * signed anew (signsAnew): the flow stays on its signing step and offers that.
 */
export function signingFinished(view: SigningView): boolean {
  return (
    view.status === 'signed' ||
    view.status === 'awaiting_second_signer' ||
    view.status === 'rejected' ||
    view.status === 'cancelled' ||
    (view.status === 'failed' && !signsAnew(view))
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
 *   done:    where each payment stands at the bank; one the bank is still
 *            confirming after the BankID reads as such (not as waiting for a
 *            signature) and is read again for a few minutes
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
  secondSignatureBatchId = null,
  offerSecondSignature = true,
  onLinkIssued,
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
  /** A signing refused at the month's cap on bank payments: the numbers it carried. */
  const [allowance, setAllowance] = useState<BankPaymentsAllowanceRefusal | null>(null)
  /** This month's bank payments against the cap; null until read, or where it cannot be (the signing link). */
  const [usage, setUsage] = useState<BankPaymentsUsage | null>(null)
  /** Where the verification stands when a signing was refused for it: the line names the state and the way out. */
  const [verification, setVerification] = useState<CompanyVerification | null>(null)
  /** The form opened from this refusal, so it can be opened again. */
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null)
  /** Set while the flow was reopened by a return from the bank's own page; cleared by the next start. */
  const [returned, setReturned] = useState<PaymentSigningReturn | null>(resume)
  /** A refused start that left its payments where no start can reach them (crm#1357): the sentence that says where, in place of the start buttons. */
  const [stopped, setStopped] = useState<string | null>(null)
  /** The signing this flow gives the second signature to, as the other signatory; null for a first signature. */
  const [second, setSecond] = useState<string | null>(secondSignatureBatchId)
  /** Skicka en länk: the payments that wait for the other signatory, while the link form is open in place of the flow. */
  const [linkOrders, setLinkOrders] = useState<SigningOrderSummary[] | null>(null)
  /** A link is out for these payments: a second one would be refused while it is open. */
  const [linkSent, setLinkSent] = useState(false)
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

  // What the month still takes, read once: informational, the server decides.
  useEffect(() => {
    if (!client.usage) return
    let cancelled = false
    client.usage().then(
      (u) => {
        if (!cancelled) setUsage(u)
      },
      () => {
        // Without the counter the flow stands; a refusal at the cap still names the numbers.
      },
    )
    return () => {
      cancelled = true
    }
  }, [client])

  // Packs bought from the allowance line raise the cap now: the counter and a
  // refusal on screen show the new numbers, and the next start is not refused.
  const raiseIncluded = useCallback((included: number) => {
    setUsage((current) => withIncludedPayments(current, included))
    setAllowance((current) => withIncludedRefusal(current, included))
  }, [])
  // An admin accepted the charge above what is included: the refusal no longer
  // holds, and the counter is read again with the new cap.
  const acceptedCharge = useCallback(() => {
    setAllowance(null)
    client.usage?.().then(setUsage, () => {
      // Without the counter the flow stands; the server decides at the next start.
    })
  }, [client])
  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const currency = orders[0]?.currency ?? 'SEK'
  // The other signatory is named by their own number, whoever holds the screen.
  const needsPersonalNumber = !signerKnown || second !== null
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
    setAllowance(null)
    setReturned(null)
    resetSteps()
    setBusy(true)
    try {
      const signer = { method: chosen, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser }
      // A BankID that ended unsigned: the orders it let go are signed in a new signing, never the spent one.
      const anew = signing && signsAnew(signing) ? (signing.sign_anew ?? []) : null
      const view = second
        ? await client.secondSignature({ batchId: second, ...signer })
        : anew
          ? await client.start({ orderIds: anew, ...signer })
          : pendingBatchId
            ? await client.restart({ batchId: pendingBatchId, ...signer })
            : await client.start({ orderIds: orders.map((o) => o.id), ...signer })
      markSentToBank()
      setSigning(view)
      adoptMethod(chosen, view)
      setStage(signingFinished(view) ? 'done' : 'signing')
    } catch (error) {
      const code = error instanceof PaymentsClientError ? error.code : null
      // The start moved the payments before it was refused (crm#1357): the
      // same start would only be refused again, as changed in the meantime.
      // A signing still waiting at the bank is signed again from here; one
      // that stopped (an unknown outcome, a refused payment) keeps its
      // sentence on screen instead of the start buttons. The list behind
      // reloads on close either way.
      const left = signingOfRefusedStart(error)
      if (left) {
        markSentToBank()
        setSigning(left)
        if (left.status === 'created') {
          setStage('signing')
          toast({ title: t('signing_start_failed_title'), description: refusalSentence(error), variant: 'destructive' })
        } else {
          setStopped(refusalSentence(error))
        }
        return
      }
      const overCap = allowanceRefusalOf(error)
      if (overCap) setAllowance(overCap)
      else if (code === 'PAYMENT_COMPANY_VERIFICATION_REQUIRED') {
        setRefusal('verification')
        // Best-effort: without the state the line falls back to the plain sentence.
        if (client.verification !== false) fetchCompanyVerification({ refresh: true }).then(setVerification, () => setVerification(null))
      }
      else if (code === 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED') setRefusal('redirect')
      else toast({ title: t('signing_start_failed_title'), description: refusalSentence(error), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  /** The bank waits for another signatory who signs here: the method step again, as that signatory. */
  function signSecond(batchId: string) {
    setSecond(batchId)
    setPersonalNumber('')
    setStage('method')
  }

  /** The first time payments reached the bank, or may have, whatever it answered: the parent reloads its list on close. */
  function markSentToBank() {
    if (sentToBank.current) return
    sentToBank.current = true
    onSentToBank?.()
  }

  /** A refused start in words: the bank's own refusal code as a sentence when we know it, else the server's. */
  function refusalSentence(error: unknown): string {
    const body = error instanceof PaymentsClientError ? error.body : null
    const details = (body as { error?: { details?: { provider_code?: string } } } | null)?.error?.details
    return providerCodeText(t, details?.provider_code) ?? getErrorMessage(body, { locale })
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
      setAllowance(null)
      adoptMethod(chosen, view)
      applyView(view)
    } catch (error) {
      const overCap = allowanceRefusalOf(error)
      if (overCap) setAllowance(overCap)
      else fail(t('signing_start_failed_title'), error)
    } finally {
      setBusy(false)
    }
  }

  // One automatic start per mount; a failed start lands on the method stage
  // where the person chooses again.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoStart || needsPersonalNumber || autoStarted.current || orders.length === 0) return
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

  // The provider refused the signing, so a stored valid is stale: the
  // refusal reads it as not started, as it does without a state.
  const refusedState = verification && verification.state !== 'valid' ? verification.state : 'not_started'
  const verificationNext = verificationStep(refusedState, { formAtHand: verificationUrl !== null })

  async function openVerification() {
    if (verificationUrl && verificationNext === 'open_form') {
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

  // The refusal's way out follows the state (lib/payments/orders/readiness
  // verificationStep): a form already out is opened again (or waits for the
  // firmatecknare), a lapsed one is renewed, a dead link is replaced.
  // Without a state the first verification is offered.
  const verificationAction = (() => {
    switch (verificationNext) {
      case 'open_form':
        return { label: t('open_verification_form'), onClick: openVerification }
      case 'new_link':
        return { label: t('new_verification_link'), onClick: openVerification }
      case 'renew':
        return { label: t('renew_company'), onClick: openVerification }
      case 'verify':
        return { label: t('verify_company'), onClick: openVerification }
      default:
        return undefined
    }
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

  // After the BankID: a payment the bank is still confirming (crm desk #1267)
  // is read again, with a growing pause, while the server follows it
  // (follow_up). The server stops a few minutes after the signing, then the
  // status sync takes over; the pauses run out on their own as well.
  const followingUp = stage === 'done' && signing?.follow_up === true
  useEffect(() => {
    if (!followingUp || !batchId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let attempt = 0
    const tick = async () => {
      try {
        const view = await client.poll({ batchId, personalNumber: typedNumber, psuAuthoriserId: typedAuthoriser }, controller.signal)
        if (stopped) return
        setSigning(view)
        if (!view.follow_up) return
      } catch {
        // A missed read is tried again after the next pause; an abort ends here.
        if (stopped) return
      }
      attempt += 1
      const delay = followUpDelayMs(attempt)
      if (delay !== null) timer = setTimeout(tick, delay)
    }
    const first = followUpDelayMs(0)
    if (first !== null) timer = setTimeout(tick, first)
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [followingUp, batchId, typedNumber, typedAuthoriser, client])

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

  // A link to the other signatory names exactly the payments of the signing
  // that wait for them (the server's rule): those the bank answered for, or,
  // opened from the list with Kontrasignera, the orders given.
  const waitingIds = signing ? new Set(signing.orders.filter((o) => o.status === 'awaiting_second_signer').map((o) => o.id)) : null
  const waitingOrders = waitingIds ? orders.filter((o) => waitingIds.has(o.id)) : orders
  const canSendLink = client.signingLinks === true && !linkSent && waitingOrders.length > 0 && (waitingIds === null || waitingOrders.length === waitingIds.size)

  if (linkOrders) {
    // Closed or sent, the flow is back where it was: the dialog's own close ends it.
    return (
      <RequestSigningLinkPanel
        orders={linkOrders}
        onClose={() => setLinkOrders(null)}
        onIssued={() => {
          setLinkSent(true)
          onLinkIssued?.()
        }}
      />
    )
  }

  if (stage === 'method' && stopped) {
    return (
      <div className="space-y-4">
        {bankLine}
        <AttnLine>{stopped}</AttnLine>
        <DialogFooter>{closeButton}</DialogFooter>
      </div>
    )
  }

  if (stage === 'method') {
    const disabled = busy || orders.length === 0 || (needsPersonalNumber && !typedNumber)
    return (
      <div className="space-y-4">
        {bankLine}
        {second && <p className="text-[13px] leading-relaxed">{t('second_signature_intro', { bank: bankLabel })}</p>}
        <p className="text-[13px] text-muted-foreground">
          {t('sign_summary', { count: orders.length, total: formatCurrency(total, currency) })}
        </p>
        {needsPersonalNumber && (
          <label className="block space-y-2 text-[13px]">
            <span className="text-muted-foreground">{t(second ? 'second_signer_personal_number_label' : 'personal_number_label')}</span>
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
        {second && canSendLink && (
          <p className="text-[12.5px] text-muted-foreground">
            {t('second_signer_elsewhere')}{' '}
            <button type="button" className={QUIET_LINK_CLASS} onClick={() => setLinkOrders(waitingOrders)}>
              {t('second_signer_send_link')}
            </button>
          </p>
        )}
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
        <BankPaymentsAllowanceLine usage={usage} count={orders.length} refusal={allowance} canRequest={Boolean(client.usage)} onIncluded={raiseIncluded} onAccepted={acceptedCharge} />
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
    // Signed again: the same signing while its payments wait at the bank
    // (created), or a new one over the orders the server let go (signsAnew).
    const anew = signsAnew(signing)
    const signableAgain = !permanent && (signing.status === 'created' || anew)
    const signAgain = anew ? begin : restart
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
            {allowance ? (
              <BankPaymentsAllowanceLine usage={usage} count={signing.orders.length} refusal={allowance} canRequest={Boolean(client.usage)} onIncluded={raiseIncluded} onAccepted={acceptedCharge} />
            ) : (
              <AttnLine>
                {permanent && failure ? (providerCodeText(t, failure) ?? t('signing_failed_permanent', { code: failure })) : (providerCodeText(t, failure) ?? t('signing_failed'))}
              </AttnLine>
            )}
            {signableAgain && psuAuthoriserField && <div className="text-left">{psuAuthoriserField}</div>}
            {signableAgain && redirect && (
              <div className="flex justify-center">
                <Button onClick={() => signAgain('redirect')} loading={busy} disabled={busy}>
                  {t('try_again')}
                </Button>
              </div>
            )}
            {signableAgain && !redirect && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onClick={() => signAgain('same_device')} loading={busy && method === 'same_device'} disabled={busy}>
                  {t('method_same_device')}
                </Button>
                <Button onClick={() => signAgain('qr')} loading={busy && method === 'qr'} disabled={busy}>
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
  // A second signature that failed (a cancelled or expired BankID) ends here too: it can be given again.
  const retryableSecond = signing?.status === 'awaiting_second_signer' && doneFailure !== null && !PERMANENT_SIGNING_FAILURES.has(doneFailure)
  const doneFailureText = doneFailure
    ? (providerCodeText(t, doneFailure) ?? (retryableSecond ? t('signing_failed') : t('signing_failed_permanent', { code: doneFailure })))
    : null
  // The bank wants one more signature: another signatory's BankID here, or a signature in its online bank.
  const awaitingSecond = signing?.status === 'awaiting_second_signer'
  const secondHere = awaitingSecond && signing?.second_signature_here === true
  const offerSecond = secondHere && offerSecondSignature && signing !== null
  const anyWithBank = (signing?.orders ?? []).some((o) =>
    ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed'].includes(o.status),
  )
  // Signed, and the bank has not confirmed them yet: nothing waits for a signature.
  const confirming = (signing?.orders ?? []).filter((o) => o.bank_confirming).length
  return (
    <div className="space-y-4">
      {doneFailureText && <AttnLine>{doneFailureText}</AttnLine>}
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
                ) : o.bank_confirming ? (
                  <Badge variant="outline">{t('status_bank_confirming')}</Badge>
                ) : variant ? (
                  <Badge variant={variant}>{secondHere && o.status === 'awaiting_second_signer' ? t('status_awaiting_second_signer_here') : statusLabel(o.status)}</Badge>
                ) : (
                  <span className="text-muted-foreground">{statusLabel(o.status)}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {confirming > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {signing?.follow_up ? t('result_bank_confirming', { count: confirming }) : t('result_bank_confirming_later', { count: confirming })}
        </p>
      )}
      {anyWithBank && !awaitingSecond && <p className="text-[12.5px] text-muted-foreground">{t('result_hint')}</p>}
      {anyWithBank && awaitingSecond && (
        // The next step, not a footnote: whose signature the bank waits for,
        // where it is given, and how a company that wants one signature gets there.
        <div className="space-y-2">
          <p className="text-[13px] leading-relaxed">{t(secondHere ? 'result_second_signer_here' : 'result_second_signer', { bank: bankLabel })}</p>
          <p className="text-[12.5px] text-muted-foreground">{t('result_sign_alone', { bank: bankLabel })}</p>
        </div>
      )}
      <DialogFooter>
        {closeButton}
        {offerSecond && canSendLink && (
          <Button variant="secondary" onClick={() => setLinkOrders(waitingOrders)}>
            {t('second_signer_send_link')}
          </Button>
        )}
        {offerSecond && signing && <Button onClick={() => signSecond(signing.batch_id)}>{t('sign_second')}</Button>}
      </DialogFooter>
    </div>
  )
}
