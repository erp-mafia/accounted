'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { ArrowDownIcon, ArrowDownTrayIcon, CheckCircleIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Textarea } from '@/components/ui/textarea'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { BankIdQrCode } from '@/components/auth/BankIdQrCode'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { bankIdAutostartHref, detectBankIdDevice } from '@/components/bankid/autostart'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SignerPageData } from '@/lib/signing/ceremony'
import { SIGNING_DECLINE_REASON_MAX } from '@/lib/signing/types'
import { cn } from '@/lib/utils'
import { SigningDocument } from './SigningDocument'
import { createSignerClient, SigningClientError, signingErrorBody, signingErrorCode } from './signing-client'

/** How often the page asks where the BankID signing stands: the animated QR changes every second. */
const POLL_MS = 1000
/** Missed polls in a row (network, a 5xx, a rate limit) before the page gives up on the signing. */
const MAX_POLL_MISSES = 8
/** What the BankID app shows as the document's checksum: the first 16 hex characters. */
const SHORT_FINGERPRINT = 16

/** Session storage and the user agent have no change events: read once, nothing to subscribe to. */
const noSubscription = () => () => {}

type Method = 'qr' | 'same_device'

interface Session {
  autoStartToken: string
  qrStartToken: string
  qrStartSecret: string
}

interface Failure {
  /** BankID's hint code from a failed poll (userCancel, expiredTransaction, ...). */
  hint: string | null
  /** Our structured code (SIGNING_SIGNER_MISMATCH, ...). */
  code: string | null
  /** The refused call's error envelope, for the server's sentence when neither maps to our own copy. */
  body: unknown
  /** Where it failed: a start refused, or a signing that did not end in a signature. */
  at: 'start' | 'poll'
}

type Stage =
  | { kind: 'ready' }
  | { kind: 'signing'; session: Session; hint: string | null }
  | { kind: 'failed'; failure: Failure }
  | { kind: 'declining' }
  /** The link stopped resolving (a reminder replaced it, or it never existed): every call answers 404. */
  | { kind: 'link_gone' }

/** Codes a poll answers that end the signing (anything else is retried a few times). */
const DEFINITIVE_POLL_CODES = new Set([
  'SIGNING_SIGNER_MISMATCH',
  'SIGNING_NAME_MISMATCH',
  'SIGNING_SUBJECT_CHANGED',
  'SIGNING_SIGNATURE_UNBOUND',
  'SIGNING_EVIDENCE_INCOMPLETE',
  'SIGNING_SESSION_MISMATCH',
  'SIGNING_SESSION_CONSUMED',
  'SIGNING_UNAVAILABLE',
  'SIGNING_RECORD_FAILED',
  'SIGNING_RECORD_REFUSED',
  'SIGNING_NOT_SIGNER',
  'FORBIDDEN',
])

/** Codes after which the signer's own state changed elsewhere: read the page again instead of saying anything. */
const REREAD_CODES = new Set(['SIGNING_REQUEST_CLOSED', 'SIGNING_SIGNER_NOT_PENDING'])

/** Our copy per structured code; `at` tells a refused start from a signing that ended badly. */
function codeKey(code: string | null, at: 'start' | 'poll'): string | null {
  switch (code) {
    case 'SIGNING_SIGNER_MISMATCH':
      return at === 'start' ? 'error_lock_unavailable' : 'error_wrong_bankid'
    case 'SIGNING_NAME_MISMATCH':
      return 'error_name_mismatch'
    case 'SIGNING_SUBJECT_CHANGED':
      return 'error_subject_changed'
    case 'SIGNING_SIGNATURE_UNBOUND':
    case 'SIGNING_EVIDENCE_INCOMPLETE':
    case 'SIGNING_SESSION_MISMATCH':
    case 'SIGNING_SESSION_CONSUMED':
    case 'SIGNING_RECORD_FAILED':
    case 'SIGNING_RECORD_REFUSED':
      return 'error_sign_again'
    case 'SIGNING_UNAVAILABLE':
      return 'error_unavailable'
    case 'SIGNING_RATE_LIMITED':
      return 'error_rate_limited'
    case 'SIGNING_PROVIDER_ERROR':
      return 'error_provider'
    default:
      return null
  }
}

/** Our copy per BankID hint code of a failed signing. */
function failedHintKey(hint: string | null): string | null {
  switch (hint) {
    case 'userCancel':
      return 'hint_failed_user_cancel'
    case 'expiredTransaction':
      return 'hint_failed_expired'
    case 'startFailed':
      return 'hint_failed_start'
    case 'certificateErr':
      return 'hint_failed_certificate'
    case 'cancelled':
      return 'hint_failed_cancelled'
    default:
      return null
  }
}

/** Our copy per BankID hint code while the signing runs. */
function pendingHintKey(hint: string | null, method: Method): string {
  switch (hint) {
    case 'userSign':
      return 'hint_user_sign'
    case 'started':
      return 'hint_started'
    case 'userCallConfirm':
    case 'userMrtd':
      return 'hint_follow_app'
    default:
      return method === 'qr' ? 'hint_scan_qr' : 'hint_open_app'
  }
}

export interface SigningPageProps {
  /**
   * The door the page's calls go through: signerTokenBase(token) for the
   * mailed link, memberSignerBase(signerId) for a logged-in member who is the
   * signer. Both answer the same shapes.
   */
  basePath: string
  /** What the server read for this request (lib/signing/ceremony.ts describeForSigner). */
  initial: SignerPageData
  /**
   * 'public': the standalone page behind the mailed link, under the sending
   * company's own name and logo. 'member': inside the dashboard panel, with
   * the page title in the top bar.
   */
  variant: 'public' | 'member'
  /**
   * What comes after this signature, when the signing is one step of a
   * longer errand (the board's årsredovisning: the årsstämma, then Digital
   * inlämning, where the fastställelseintyg is signed at Bolagsverket).
   * Shown under the signed state.
   */
  nextStep?: { body: string; href: string; label: string } | null
}

/**
 * The signer's page, document first: the PDF itself is the page, drawn sheet
 * by sheet (SigningDocument), under the sending company's name and logo, with
 * everyone asked to sign, the details and the SHA-256 fingerprint beside it
 * (below it on a phone; the first 16 characters are what the BankID app
 * shows). Signera med BankID waits in a bar at the bottom until the reader
 * has scrolled to the end of the last page (a reading aid, nothing more: if
 * the document cannot be drawn here, opening the file unlocks it). BankID
 * then runs in a dialog (the animated QR, or the BankID app on this device),
 * polled about once a second until it signs or fails. The signer can stop a
 * signing in progress, or decline with an optional reason after a confirm
 * step. End states: signed (also when opened again later), declined, the
 * request closed (completed, declined by someone else, cancelled, expired)
 * and a link that no longer opens.
 */
export function SigningPage({ basePath, initial, variant, nextStep = null }: SigningPageProps) {
  const t = useTranslations('signing_page')
  const locale = useLocale() as ErrorLocale
  const format = useFormatter()
  const client = useMemo(() => createSignerClient(basePath), [basePath])
  const [data, setData] = useState<SignerPageData>(initial)
  const [stage, setStage] = useState<Stage>({ kind: 'ready' })
  const [busy, setBusy] = useState<'start' | 'cancel' | 'decline' | null>(null)
  const [reason, setReason] = useState('')
  /** A refused decline's error envelope (shown under the reason), or null. */
  const [declineError, setDeclineError] = useState<{ body: unknown } | null>(null)
  // A phone carries the BankID app itself: the same-device button leads there.
  const mobile = useSyncExternalStore(noSubscription, () => detectBankIdDevice().mobile, () => false)
  const [methodChoice, setMethodChoice] = useState<Method | null>(null)
  const method: Method = methodChoice ?? (mobile ? 'same_device' : 'qr')

  // The document and the read-to-the-end gate.
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [reachedEnd, setReachedEnd] = useState(false)
  const [renderFailed, setRenderFailed] = useState(false)
  const [openedFile, setOpenedFile] = useState(false)
  const documentRef = useRef<HTMLDivElement>(null)
  const gateId = useId()
  /** A UX gate only: the signature itself binds the document's hash, whatever was scrolled. */
  const unlocked = reachedEnd || (renderFailed && openedFile)

  const { request, signer } = data
  const requester = request.requester
  const moment = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short' })
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'long' })

  /** Read the page again: the signer's status, the others', the request's state. A 404 means the link no longer opens. */
  const refresh = useCallback(async () => {
    try {
      setData(await client.describe())
    } catch (error) {
      if (error instanceof SigningClientError && error.status === 404) setStage({ kind: 'link_gone' })
    }
  }, [client])

  /** A refused call: the link gone, the signer's state moved on (read again), or a failure to show. */
  const refused = useCallback(
    (error: unknown, at: 'start' | 'poll'): Stage => {
      const code = signingErrorCode(error)
      if (error instanceof SigningClientError && error.status === 404) return { kind: 'link_gone' }
      if (code && REREAD_CODES.has(code)) {
        void refresh()
        return { kind: 'ready' }
      }
      return { kind: 'failed', failure: { hint: null, code, body: signingErrorBody(error), at } }
    },
    [refresh],
  )

  async function begin(chosen: Method) {
    setBusy('start')
    try {
      const started = await client.start()
      setMethodChoice(chosen)
      setStage({
        kind: 'signing',
        session: { autoStartToken: started.auto_start_token, qrStartToken: started.qr_start_token, qrStartSecret: started.qr_start_secret },
        hint: null,
      })
    } catch (error) {
      setMethodChoice(chosen)
      setStage(refused(error, 'start'))
    } finally {
      setBusy(null)
    }
  }

  async function cancelSigning() {
    // Stop polling first, so a poll racing the cancel cannot report the stopped signing as a failure.
    setStage({ kind: 'ready' })
    setBusy('cancel')
    try {
      await client.cancel()
    } catch {
      // Stopped or not, the page offers a new start; a new start cancels a running one first.
    } finally {
      setBusy(null)
    }
  }

  async function decline() {
    setBusy('decline')
    setDeclineError(null)
    try {
      await client.decline(reason.trim() || null)
      await refresh()
      setStage({ kind: 'ready' })
    } catch (error) {
      const next = refused(error, 'start')
      if (next.kind === 'failed') setDeclineError({ body: next.failure.body })
      else setStage(next)
    } finally {
      setBusy(null)
    }
  }

  function leaveDecline() {
    setDeclineError(null)
    setStage({ kind: 'ready' })
  }

  /** About one screen further down the document, in whatever scrolls it (the window, or the dashboard panel). */
  function scrollOn() {
    const from = documentRef.current
    if (!from) return
    const scroller = scrollParent(from)
    const height = scroller ? scroller.clientHeight : window.innerHeight
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    ;(scroller ?? window).scrollBy({ top: Math.round(height * SCROLL_STEP), behavior })
  }

  // Poll while BankID is open. One request at a time (the next is scheduled
  // when the previous answered), aborted on unmount or when the stage moves
  // on. A pending answer may carry fresh QR tokens: the QR adopts them.
  const polling = stage.kind === 'signing'
  useEffect(() => {
    if (!polling) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let misses = 0
    const tick = async () => {
      try {
        const answer = await client.poll(controller.signal)
        if (stopped) return
        misses = 0
        if (answer.state === 'pending') {
          setStage((prev) =>
            prev.kind !== 'signing'
              ? prev
              : {
                  ...prev,
                  hint: answer.hint_code ?? prev.hint,
                  session:
                    answer.qr_start_token && answer.qr_start_secret
                      ? { ...prev.session, qrStartToken: answer.qr_start_token, qrStartSecret: answer.qr_start_secret }
                      : prev.session,
                },
          )
        } else if (answer.state === 'signed') {
          // Say it at once; the reread brings the BankID name and the others' status.
          setData((prev) => ({
            ...prev,
            signer: { ...prev.signer, status: 'signed', signed_at: answer.signed_at ?? prev.signer.signed_at },
            request: { ...prev.request, state: answer.completed ? 'completed' : prev.request.state },
          }))
          setStage({ kind: 'ready' })
          void refresh()
          return
        } else if (answer.state === 'failed') {
          setStage({ kind: 'failed', failure: { hint: answer.hint_code, code: answer.code, body: null, at: 'poll' } })
          return
        } else {
          // No session any more (stopped elsewhere, or recording it failed): the reread shows why, if it was kept.
          setStage({ kind: 'ready' })
          void refresh()
          return
        }
      } catch (error) {
        if (stopped) return
        const code = signingErrorCode(error)
        const status = error instanceof SigningClientError ? error.status : 0
        if (status === 404 || (code && (DEFINITIVE_POLL_CODES.has(code) || REREAD_CODES.has(code)))) {
          setStage(refused(error, 'poll'))
          return
        }
        // A missed poll (network, a 5xx, the rate limit) is retried, a few times.
        misses += 1
        if (misses >= MAX_POLL_MISSES) {
          setStage({ kind: 'failed', failure: { hint: null, code: code ?? 'SIGNING_PROVIDER_ERROR', body: null, at: 'poll' } })
          return
        }
      }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [polling, client, refresh, refused])

  function failureText(failure: Failure): string {
    const key = codeKey(failure.code, failure.at) ?? failedHintKey(failure.hint)
    if (key) return t(key, { requester })
    return getErrorMessage(failure.body, { locale, fallback: t('error_generic') })
  }

  const open = request.state === 'open'
  const pending = signer.status === 'pending'
  /** Still to be read and signed: everything else is an end state. */
  const reading = stage.kind !== 'link_gone' && pending && open
  const otherMethod: Method = method === 'qr' ? 'same_device' : 'qr'
  const isPublic = variant === 'public'

  // ---------------------------------------------------------------------------
  // The parts
  // ---------------------------------------------------------------------------

  const pageCounter =
    pageCount && !renderFailed ? (
      <span className="text-[13px] tabular-nums text-muted-foreground">
        <span className="hidden sm:inline">{t('page_of', { page: currentPage, count: pageCount })}</span>
        <span className="sm:hidden">{t('page_of_short', { page: currentPage, count: pageCount })}</span>
      </span>
    ) : null

  const downloadButtons = (
    <>
      <Button asChild variant="outline" className="hidden gap-2 sm:inline-flex">
        <a href={client.documentUrl} download={request.file_name}>
          <ArrowDownTrayIcon className="h-4 w-4" />
          {t('download')}
        </a>
      </Button>
      <Button asChild variant="ghost" size="icon" className="sm:hidden">
        <a href={client.documentUrl} download={request.file_name} aria-label={t('download_label')}>
          <ArrowDownTrayIcon className="h-4 w-4" />
        </a>
      </Button>
    </>
  )

  const lead = (
    <div className="space-y-3">
      {isPublic && (
        <h1 className="text-2xl leading-tight sm:text-3xl" data-ph-mask="">
          {request.title}
        </h1>
      )}
      <p className="text-sm text-foreground/80 sm:text-[15px]" data-ph-mask="">
        {requester === request.company_name ? t('lead_company', { company: request.company_name }) : t('lead', { requester })}
        {pageCount ? ` ${t('lead_pages', { count: pageCount })}` : null}
      </p>
      {request.message && (
        <p className="whitespace-pre-line text-sm italic text-muted-foreground" data-ph-mask="">
          {t('message_quoted', { message: request.message })}
        </p>
      )}
    </div>
  )

  const documentView = (
    <SigningDocument
      url={client.documentUrl}
      fileName={request.file_name}
      onLoaded={setPageCount}
      onPage={setCurrentPage}
      onReachedEnd={() => setReachedEnd(true)}
      onFailed={() => setRenderFailed(true)}
      onOpened={() => setOpenedFile(true)}
    />
  )

  const endNote = pageCount && !renderFailed ? <p className="text-center text-[13px] text-muted-foreground">{t('end_of_document')}</p> : null

  const details = (
    <>
      <section className="space-y-4">
        <h2 className="font-sans text-xs font-medium text-muted-foreground">{t('signers_heading')}</h2>
        <ul className="space-y-3" data-ph-mask="">
          {data.signers.map((s) => {
            const mine = s.position === signer.position
            const sub = [mine ? t('you_label') : null, s.role_label].filter(Boolean).join(', ')
            return (
              <li key={s.position} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                    mine ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {initials(s.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{s.name}</div>
                  {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
                </div>
                <SignerStatus status={s.status} />
              </li>
            )
          })}
        </ul>
        {signer.locked && <p className="text-xs text-muted-foreground">{t('locked_note')}</p>}
      </section>
      <dl className="space-y-3 border-t-hairline pt-6 text-[13px]">
        <DetailRow label={t('detail_sent')}>
          <span data-ph-mask="">{t('detail_sent_value', { date: format.dateTime(new Date(request.sent_at), { day: 'numeric', month: 'long' }), requester })}</span>
        </DetailRow>
        <DetailRow label={t('detail_expires')}>{day(request.expires_at)}</DetailRow>
        <DetailRow label={t('detail_file')}>
          <span className="break-all" data-ph-mask="">
            {pageCount ? t('detail_file_value', { file: request.file_name, count: pageCount }) : request.file_name}
          </span>
        </DetailRow>
        <Fingerprint sha256={request.sha256} />
      </dl>
      <div className="space-y-3 lg:mt-auto">
        <button type="button" className={cn(QUIET_LINK_CLASS, 'text-[13px]')} onClick={() => setStage({ kind: 'declining' })}>
          {t('decline_link')}
        </button>
        <p className="text-xs leading-5 text-muted-foreground">{isPublic ? `${t('footer_personal')} ${t('nothing_signed_until')}` : t('nothing_signed_until')}</p>
      </div>
    </>
  )

  // Ready, or the last try failed: the reason sits in the bar beside the way in.
  const failedNow = stage.kind === 'failed' ? failureText(stage.failure) : null
  const failedBefore = !failedNow && signer.last_error_code ? t(codeKey(signer.last_error_code, 'poll') ?? 'error_sign_again', { requester }) : null
  let gateText: React.ReactNode
  if (!unlocked) {
    gateText = renderFailed ? t('gate_open_file') : pageCount ? t('gate_scroll', { count: pageCount }) : t('gate_loading')
  } else if (failedNow ?? failedBefore) {
    gateText = <AttnLine>{failedNow ?? failedBefore}</AttnLine>
  } else {
    gateText = t('gate_read')
  }

  const signButton = (
    <Button
      size="lg"
      variant={unlocked ? 'default' : 'outline'}
      onClick={() => begin(method)}
      loading={busy === 'start'}
      disabled={!unlocked || busy !== null}
      aria-describedby={gateId}
      className={cn('w-full gap-2 sm:w-auto', !unlocked && 'disabled:text-muted-foreground disabled:opacity-100')}
    >
      {/* Always mounted (hidden while the spinner runs), so no node comes and goes beside the label. */}
      <BankIdMark size={22} className={cn(unlocked ? 'invert dark:invert-0' : 'opacity-50', busy === 'start' && 'hidden')} />
      {stage.kind === 'failed' ? t('try_again') : t('sign_with_bankid')}
    </Button>
  )

  const gate = (
    <div id={gateId} className="text-center text-[13px] text-muted-foreground sm:text-left sm:text-sm" aria-live="polite">
      {gateText}
    </div>
  )

  const showArrow = pageCount !== null && !renderFailed && !reachedEnd
  const arrow = showArrow ? (
    <div className="pointer-events-none flex justify-center pb-6">
      <Button size="lg" onClick={scrollOn} aria-label={t('scroll_next_label')} className="pointer-events-auto gap-2 shadow-[var(--shadow-lg)] max-sm:w-11 max-sm:px-0">
        <ArrowDownIcon className="h-5 w-5" />
        <span className="max-sm:hidden">{t('scroll_next')}</span>
      </Button>
    </div>
  ) : null

  const scanned = stage.kind === 'signing' && stage.hint === 'userSign'
  const dialogs = (
    <>
      <Dialog
        open={stage.kind === 'signing'}
        onOpenChange={(next) => {
          if (!next) void cancelSigning()
        }}
      >
        <DialogContent size="confirm">
          {stage.kind === 'signing' && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="flex items-center gap-2">
                <BankIdMark />
                <DialogTitle className="text-xl">{t('signing_title')}</DialogTitle>
              </div>
              <DialogDescription className="text-[13px]" data-ph-mask="">
                {signer.role_label ? t('sign_intro_role', { name: signer.name, role: signer.role_label }) : t('sign_intro', { name: signer.name })}
              </DialogDescription>
              {method === 'qr' && !scanned && <BankIdQrCode qrStartToken={stage.session.qrStartToken} qrStartSecret={stage.session.qrStartSecret} />}
              <p className="text-[13px]" role="status" aria-live="polite">
                {t(pendingHintKey(stage.hint, method))}
              </p>
              {method === 'same_device' && !scanned && (
                <Button asChild size="lg">
                  <a href={bankIdAutostartHref(stage.session.autoStartToken)}>{t('open_bankid')}</a>
                </Button>
              )}
              <Button variant="outline" onClick={cancelSigning} loading={busy === 'cancel'} disabled={busy !== null}>
                {t('cancel_signing')}
              </Button>
              {!scanned && (
                <button type="button" className={QUIET_LINK_CLASS} onClick={() => setMethodChoice(otherMethod)}>
                  {method === 'qr' ? t('switch_to_same_device') : t('switch_to_qr')}
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={stage.kind === 'declining'}
        onOpenChange={(next) => {
          if (!next && busy !== 'decline') leaveDecline()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-xl">{t('decline_title')}</DialogTitle>
            <DialogDescription className="text-[13px]">{t('decline_body', { requester })}</DialogDescription>
          </DialogHeader>
          <label className="block space-y-2 text-[13px]">
            <span className="text-muted-foreground">{t('decline_reason_label')}</span>
            <Textarea value={reason} maxLength={SIGNING_DECLINE_REASON_MAX} rows={3} onChange={(e) => setReason(e.target.value)} placeholder={t('decline_reason_placeholder')} />
          </label>
          {declineError && <AttnLine>{getErrorMessage(declineError.body, { locale, fallback: t('error_generic') })}</AttnLine>}
          <DialogFooter>
            <Button variant="outline" onClick={leaveDecline} disabled={busy !== null}>
              {t('decline_back')}
            </Button>
            <Button variant="destructive" onClick={decline} loading={busy === 'decline'} disabled={busy !== null}>
              {t('decline_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )

  // ---------------------------------------------------------------------------
  // End states: signed, declined, closed, the link gone
  // ---------------------------------------------------------------------------

  function endState(): { title: string; lines: string[]; closing: string | null; check: boolean } {
    if (stage.kind === 'link_gone') return { title: t('link_gone_title'), lines: [t('link_gone_body', { requester })], closing: null, check: false }
    if (signer.status === 'signed') {
      const when = signer.signed_at
        ? signer.bankid_name
          ? t('signed_body_named', { moment: moment(signer.signed_at), name: signer.bankid_name })
          : t('signed_body', { moment: moment(signer.signed_at) })
        : t('signed_body_now')
      return {
        title: t('signed_title'),
        lines: [`${withStop(request.title)} ${when}`],
        closing: request.state === 'completed' ? t('signed_all', { requester }) : t('signed_waiting_others', { requester }),
        check: true,
      }
    }
    if (signer.status === 'declined') return { title: t('declined_title'), lines: [t('declined_body', { requester })], closing: null, check: false }
    const key = request.state === 'expired' ? 'expired' : request.state === 'cancelled' ? 'cancelled' : request.state === 'declined' ? 'declined_by_other' : 'completed'
    return { title: t(`closed_${key}_title`), lines: [t(`closed_${key}_body`, { requester, date: day(request.expires_at) })], closing: null, check: false }
  }

  if (!reading) {
    const end = endState()
    const Heading = isPublic ? 'h1' : 'h2'
    const showList = stage.kind !== 'link_gone'
    const offerCopy = showList && request.state === 'completed' && request.signed_copy && signer.status !== 'declined'
    const times = data.signers.map((s) => s.signed_at).filter((v): v is string => Boolean(v))
    const oneDay = new Set(times.map((iso) => format.dateTime(new Date(iso), { dateStyle: 'short' }))).size <= 1
    const when = (iso: string) => format.dateTime(new Date(iso), oneDay ? { timeStyle: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

    const column = (
      <div className="flex flex-1 flex-col">
        <div className="space-y-4">
          {end.check && <CheckCircleIcon className="h-11 w-11 text-foreground" aria-hidden="true" />}
          <Heading className="text-xl font-medium text-strong">{end.title}</Heading>
          {end.lines.map((line) => (
            <p key={line} className="text-[15px] text-foreground/80" data-ph-mask="">
              {line}
            </p>
          ))}
        </div>
        {showList && (
          <ul className="mt-8 border-t-hairline text-sm" data-ph-mask="">
            {data.signers.map((s) => (
              <li key={s.position} className="flex items-baseline justify-between gap-4 border-b-hairline py-3">
                <span className="min-w-0 truncate">
                  {s.name}
                  {s.role_label ? `, ${s.role_label}` : null}
                  {s.position === signer.position ? <span className="text-muted-foreground">{` (${t('you')})`}</span> : null}
                </span>
                {s.status === 'signed' && s.signed_at ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground">{when(s.signed_at)}</span>
                ) : (
                  <SignerStatus status={s.status} />
                )}
              </li>
            ))}
          </ul>
        )}
        {end.closing && (
          <p className="mt-8 text-sm text-foreground/80" data-ph-mask="">
            {end.closing}
          </p>
        )}
        {nextStep && signer.status === 'signed' && (
          <div className="mt-8 space-y-3 border-t-hairline pt-6">
            <p className="text-[13px]">{nextStep.body}</p>
            <Button asChild>
              <Link href={nextStep.href}>{nextStep.label}</Link>
            </Button>
          </div>
        )}
        <div className="mt-auto space-y-4 pt-10 sm:mt-0">
          {offerCopy ? (
            <Button asChild size="lg" className="w-full">
              <a href={client.signedCopyUrl}>
                <ArrowDownTrayIcon className="h-4 w-4" />
                {t('download_signed_copy')}
              </a>
            </Button>
          ) : (
            showList && (
              <a href={client.documentUrl} target="_blank" rel="noopener noreferrer" className={cn(QUIET_LINK_CLASS, 'block text-center text-[13px]')}>
                {t('open_document')}
              </a>
            )
          )}
          {signer.status === 'signed' && isPublic && <p className="text-center text-xs text-muted-foreground">{t('signed_via', { platform: request.platform_name })}</p>}
        </div>
      </div>
    )

    if (!isPublic) {
      return (
        <div className="space-y-8">
          <PageHeader title={<span data-ph-mask="">{request.title}</span>} meta={<span data-ph-mask="">{request.company_name}</span>} />
          <div className="flex max-w-lg flex-col">{column}</div>
        </div>
      )
    }
    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <SigningHeader company={request.company_name} logoUrl={request.logo_url} via={t('via', { platform: request.platform_name })} />
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 pb-8 pt-12 sm:pt-16">{column}</main>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Reading: the document, the details, the bar
  // ---------------------------------------------------------------------------

  if (!isPublic) {
    return (
      <div className="space-y-8">
        <PageHeader
          title={<span data-ph-mask="">{request.title}</span>}
          meta={<span data-ph-mask="">{request.company_name}</span>}
          action={
            <div className="flex items-center gap-4">
              {pageCounter}
              {downloadButtons}
            </div>
          }
        />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div ref={documentRef} className="min-w-0 space-y-6">
            {lead}
            <div className="flex flex-col items-center gap-6 rounded-lg bg-frame p-4 md:p-6">
              <div className="w-full max-w-3xl">{documentView}</div>
              {endNote}
            </div>
            <div className="sticky bottom-[calc(var(--bottom-nav-h)+1rem)] z-10 md:bottom-4">
              {arrow}
              <div className="flex flex-col gap-2 rounded-xl border border-border bg-background px-4 py-3 shadow-[var(--shadow-md)] sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:pl-6">
                {gate}
                {signButton}
              </div>
            </div>
          </div>
          <aside className="flex flex-col gap-6 lg:sticky lg:top-16 lg:self-start">{details}</aside>
        </div>
        {dialogs}
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-frame pb-40 text-foreground lg:pb-0">
      <SigningHeader company={request.company_name} logoUrl={request.logo_url} via={t('via', { platform: request.platform_name })}>
        {pageCounter}
        {downloadButtons}
      </SigningHeader>
      <div className="lg:mr-80">
        <main ref={documentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-6 pt-6 sm:pt-10 md:px-6 lg:pb-48">
          {lead}
          {documentView}
          {endNote}
        </main>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 md:px-6">
        <aside className="flex flex-col gap-6 rounded-lg p-6 lg:fixed lg:bottom-0 lg:right-0 lg:top-16 lg:w-80 lg:gap-8 lg:overflow-y-auto lg:rounded-none lg:border-0 lg:border-l lg:px-6 lg:py-8 bg-control shadow-raised">
          {details}
        </aside>
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 lg:right-80">
        {arrow}
        <div className="pointer-events-auto border-t-hairline bg-background">
          <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] pt-3 sm:h-20 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:py-0 md:px-6 lg:max-w-none lg:px-10">
            {gate}
            {signButton}
          </div>
        </div>
      </div>
      {dialogs}
    </div>
  )
}

/** How far "Bläddra vidare" scrolls: three quarters of a screen, so the last lines stay in sight. */
const SCROLL_STEP = 0.75

/** The nearest ancestor that scrolls (the dashboard panel), or null for the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/** A title as the start of a sentence: a full stop after it, unless it ends in one already. */
function withStop(title: string): string {
  return /[.!?]$/.test(title.trim()) ? title.trim() : `${title.trim()}.`
}

/** Legal-form suffixes that say nothing about who the company is. */
const FORM_SUFFIXES = new Set(['ab', 'hb', 'kb', '(publ)'])

/** Up to two initials for a name: "Arcim Technology AB" is AT, "Jakob Wennberg" JW. */
function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word && !FORM_SUFFIXES.has(word.toLowerCase()))
  const letters = (words.length > 0 ? words : [name.trim()]).slice(0, 2).map((word) => Array.from(word)[0] ?? '')
  return letters.join('').toUpperCase()
}

/** The sending company: its own logo, or its initials on a tile when it has none (or it does not load). */
function SenderMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const [broken, setBroken] = useState(false)
  if (logoUrl && !broken) {
    return (
      // A company's uploaded logo, any size and shape: a plain img, sized by height (next/image needs its host configured).
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt="" onError={() => setBroken(true)} className="h-8 w-auto max-w-32 shrink-0 rounded-lg object-contain sm:h-9" />
    )
  }
  return (
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-[13px] font-medium text-secondary-foreground sm:h-9 sm:w-9">
      {initials(name)}
    </span>
  )
}

/** The public page's header: who sends the document (logo, name, the platform it went through), and the reading tools. */
function SigningHeader({ company, logoUrl, via, children }: { company: string; logoUrl: string | null; via: string; children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b-hairline bg-background px-4 sm:h-16 md:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <SenderMark name={company} logoUrl={logoUrl} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" data-ph-mask="">
            {company}
          </div>
          <div className="hidden truncate text-xs text-muted-foreground sm:block">{via}</div>
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-4">{children}</div>}
    </header>
  )
}

/** Where one signer stands: muted text, a chip only for the exception (a decline). */
function SignerStatus({ status }: { status: SignerPageData['signers'][number]['status'] }) {
  const t = useTranslations('signing_page')
  if (status === 'declined') return <Badge variant="warning">{t('status_declined')}</Badge>
  return <span className="shrink-0 text-xs text-muted-foreground">{status === 'signed' ? t('status_signed') : t('status_pending')}</span>
}

/** One fact about the request: the label left, the value right. */
function DetailRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  )
}

/**
 * The document's SHA-256: the first 16 characters (what the BankID app shows
 * as Kontrollsumma), the full value one click away.
 */
function Fingerprint({ sha256 }: { sha256: string }) {
  const t = useTranslations('signing_page')
  const [full, setFull] = useState(false)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="flex shrink-0 items-center gap-1 text-muted-foreground">
          {t('fingerprint_label')}
          <HelpPopover>{t('fingerprint_help')}</HelpPopover>
        </dt>
        {!full && <dd className="font-mono text-xs">{sha256.slice(0, SHORT_FINGERPRINT)}</dd>}
      </div>
      {full && <dd className="break-all font-mono text-xs">{sha256}</dd>}
      <dd className="text-right">
        <button type="button" className={QUIET_LINK_CLASS} onClick={() => setFull((v) => !v)} aria-expanded={full}>
          {full ? t('fingerprint_short') : t('fingerprint_full')}
        </button>
      </dd>
    </div>
  )
}
