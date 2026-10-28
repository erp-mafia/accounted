'use client'

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { Textarea } from '@/components/ui/textarea'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { BankIdQrCode } from '@/components/auth/BankIdQrCode'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { bankIdAutostartHref, detectBankIdDevice } from '@/components/bankid/autostart'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SignerPageData } from '@/lib/signing/ceremony'
import { SIGNING_DECLINE_REASON_MAX } from '@/lib/signing/types'
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
   * 'public': the standalone page behind the mailed link (wordmark, one
   * calm column, the link's footer). 'member': inside the dashboard panel,
   * with the page title in the top bar and the document beside the details.
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
 * The signer's page: what is asked (title, company, who asks, the message),
 * the PDF itself with its SHA-256 fingerprint (the first 16 characters are
 * what the BankID app shows), everyone asked to sign and where each stands,
 * then Signera med BankID (the animated QR, or the BankID app on this
 * device), polled about once a second until it signs or fails. The signer
 * can stop a signing in progress, or decline with an optional reason after
 * a confirm step. End states: signed (also when opened again later),
 * declined, the request closed (completed, declined by someone else,
 * cancelled, expired) and a link that no longer opens.
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
  /** The method of the start in flight, so only its button spins and the labels hold still. */
  const [startingWith, setStartingWith] = useState<Method | null>(null)

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
    setStartingWith(chosen)
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
      setStartingWith(null)
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
  const others = data.signers
  // The signer's own row among everyone's.
  const myPosition = signer.position
  const otherMethod: Method = method === 'qr' ? 'same_device' : 'qr'

  // ---------------------------------------------------------------------------
  // The parts
  // ---------------------------------------------------------------------------

  const intro = (
    <p className="text-[13px] text-muted-foreground" data-ph-mask="">
      {requester === request.company_name ? t('asked_by_company', { company: request.company_name }) : t('asked_by', { requester, company: request.company_name })}
    </p>
  )

  const message = request.message ? (
    <div className="space-y-1">
      <p className="text-[12.5px] text-muted-foreground">{t('message_heading', { requester })}</p>
      <p className="whitespace-pre-line border-l-2 border-border pl-3 text-[13px]" data-ph-mask="">
        {request.message}
      </p>
    </div>
  ) : null

  const documentView =
    stage.kind === 'link_gone' ? null : (
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <p className="min-w-0 truncate text-[13px]" data-ph-mask="">
            {request.file_name}
          </p>
          <a href={client.documentUrl} target="_blank" rel="noopener noreferrer" className={`${QUIET_LINK_CLASS} shrink-0`}>
            {t('open_document')}
          </a>
        </div>
        <object
          data={client.documentUrl}
          type="application/pdf"
          aria-label={request.file_name}
          className={variant === 'member' ? 'h-[72vh] w-full rounded-lg border border-border bg-white' : 'h-[60vh] w-full rounded-lg border border-border bg-white md:h-[70vh]'}
        >
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[13px] text-muted-foreground">
            <p>{t('document_no_preview')}</p>
            <a href={client.documentUrl} target="_blank" rel="noopener noreferrer" className={QUIET_LINK_CLASS}>
              {t('open_document')}
            </a>
          </div>
        </object>
        <Fingerprint sha256={request.sha256} />
      </section>
    )

  const signerList = (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t('signers_heading')}</h2>
      <ul className="text-[13px]" data-ph-mask="">
        {others.map((s) => (
          <li key={s.position} className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
            <span className="min-w-0 truncate">
              {s.name}
              {s.role_label ? <span className="text-muted-foreground">{`, ${s.role_label}`}</span> : null}
              {s.position === myPosition ? <span className="text-muted-foreground">{` (${t('you')})`}</span> : null}
            </span>
            {s.status === 'declined' ? (
              <Badge variant="warning">{t('status_declined')}</Badge>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">{s.status === 'signed' ? t('status_signed') : t('status_pending')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )

  const declineLink = (
    <button type="button" className={QUIET_LINK_CLASS} onClick={() => setStage({ kind: 'declining' })}>
      {t('decline_link')}
    </button>
  )

  const startButtons = (primaryLabel: string) => (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => begin(method)} loading={startingWith === method} disabled={busy !== null}>
        {primaryLabel}
      </Button>
      <Button variant="secondary" onClick={() => begin(otherMethod)} loading={startingWith === otherMethod} disabled={busy !== null}>
        {otherMethod === 'qr' ? t('method_qr') : t('method_same_device')}
      </Button>
    </div>
  )

  let action: React.ReactNode
  if (stage.kind === 'link_gone') {
    action = <EndState title={t('link_gone_title')} body={t('link_gone_body', { requester })} />
  } else if (signer.status === 'signed') {
    action = (
      <div className="space-y-4">
        <EndState
          title={t('signed_title')}
          body={[
            signer.signed_at
              ? signer.bankid_name
                ? t('signed_body_named', { moment: moment(signer.signed_at), name: signer.bankid_name })
                : t('signed_body', { moment: moment(signer.signed_at) })
              : t('signed_body_now'),
            request.state === 'completed' ? t('signed_all', { requester }) : t('signed_waiting_others', { requester }),
          ]}
        />
        {request.state === 'completed' && request.signed_copy && (
          <a href={client.signedCopyUrl} className={QUIET_LINK_CLASS}>
            {t('download_signed_copy')}
          </a>
        )}
        {nextStep && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-[13px]">{nextStep.body}</p>
            <Button asChild>
              <Link href={nextStep.href}>{nextStep.label}</Link>
            </Button>
          </div>
        )}
      </div>
    )
  } else if (signer.status === 'declined') {
    action = <EndState title={t('declined_title')} body={t('declined_body', { requester })} />
  } else if (!open) {
    const key = request.state === 'expired' ? 'expired' : request.state === 'cancelled' ? 'cancelled' : request.state === 'declined' ? 'declined_by_other' : 'completed'
    action = (
      <div className="space-y-4">
        <EndState title={t(`closed_${key}_title`)} body={t(`closed_${key}_body`, { requester, date: day(request.expires_at) })} />
        {key === 'completed' && request.signed_copy && (
          <a href={client.signedCopyUrl} className={QUIET_LINK_CLASS}>
            {t('download_signed_copy')}
          </a>
        )}
      </div>
    )
  } else if (stage.kind === 'declining') {
    action = (
      <div className="space-y-4">
        <h2 className="font-display text-xl tracking-tight">{t('decline_title')}</h2>
        <p className="text-[13px] text-muted-foreground">{t('decline_body', { requester })}</p>
        <label className="block space-y-2 text-[13px]">
          <span className="text-muted-foreground">{t('decline_reason_label')}</span>
          <Textarea value={reason} maxLength={SIGNING_DECLINE_REASON_MAX} rows={3} onChange={(e) => setReason(e.target.value)} placeholder={t('decline_reason_placeholder')} />
        </label>
        {declineError && <AttnLine>{getErrorMessage(declineError.body, { locale, fallback: t('error_generic') })}</AttnLine>}
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" onClick={decline} loading={busy === 'decline'} disabled={busy !== null}>
            {t('decline_confirm')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDeclineError(null)
              setStage({ kind: 'ready' })
            }}
            disabled={busy !== null}
          >
            {t('decline_back')}
          </Button>
        </div>
      </div>
    )
  } else if (stage.kind === 'signing') {
    const scanned = stage.hint === 'userSign'
    action = (
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2">
          <BankIdMark />
          <h2 className="font-display text-xl tracking-tight">{t('signing_title')}</h2>
        </div>
        {method === 'qr' && !scanned && <BankIdQrCode qrStartToken={stage.session.qrStartToken} qrStartSecret={stage.session.qrStartSecret} />}
        <p className="text-[13px]" role="status" aria-live="polite">
          {t(pendingHintKey(stage.hint, method))}
        </p>
        {method === 'same_device' && !scanned && (
          <Button asChild size="lg">
            <a href={bankIdAutostartHref(stage.session.autoStartToken)}>{t('open_bankid')}</a>
          </Button>
        )}
        <Button variant="secondary" onClick={cancelSigning} loading={busy === 'cancel'} disabled={busy !== null}>
          {t('cancel_signing')}
        </Button>
        {!scanned && (
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setMethodChoice(otherMethod)}>
            {method === 'qr' ? t('switch_to_same_device') : t('switch_to_qr')}
          </button>
        )}
      </div>
    )
  } else {
    // Ready, or the last try failed: the same way in, with the reason above it.
    const failedNow = stage.kind === 'failed' ? failureText(stage.failure) : null
    const failedBefore = !failedNow && signer.last_error_code ? t(codeKey(signer.last_error_code, 'poll') ?? 'error_sign_again', { requester }) : null
    action = (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <BankIdMark />
          <h2 className="font-display text-xl tracking-tight">{t('sign_title')}</h2>
        </div>
        <p className="text-[13px] text-muted-foreground" data-ph-mask="">
          {signer.role_label ? t('sign_intro_role', { name: signer.name, role: signer.role_label }) : t('sign_intro', { name: signer.name })}
        </p>
        {signer.locked && <p className="text-[12.5px] text-muted-foreground">{t('locked_note')}</p>}
        {(failedNow ?? failedBefore) && <AttnLine>{failedNow ?? failedBefore}</AttnLine>}
        {startButtons(stage.kind === 'failed' ? t('try_again') : t('sign_with_bankid'))}
        {declineLink}
      </div>
    )
  }

  const actionCard = <section className="space-y-4 rounded-lg border border-border p-6">{action}</section>
  const expiresLine = open && pending && stage.kind !== 'link_gone' ? t('expires', { date: day(request.expires_at) }) : null

  if (variant === 'member') {
    return (
      <div className="space-y-8">
        <PageHeader title={<span data-ph-mask="">{request.title}</span>} meta={<span data-ph-mask="">{request.company_name}</span>} />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-4 lg:self-start">{documentView}</div>
          <div className="space-y-8">
            <div className="space-y-4">
              {intro}
              {message}
            </div>
            {actionCard}
            {signerList}
            {expiresLine && <p className="text-[12.5px] text-muted-foreground">{expiresLine}</p>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-10 md:px-6">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <header className="space-y-4">
          <BrandWordmark size="inline" />
          <div className="space-y-1">
            <h1 className="font-display text-2xl tracking-tight" data-ph-mask="">
              {request.title}
            </h1>
            {intro}
          </div>
          {message}
        </header>
        {documentView}
        {signerList}
        {actionCard}
        <p className="text-[12.5px] text-muted-foreground">
          {expiresLine ? `${expiresLine} ` : ''}
          {t('footer_personal')}
        </p>
      </div>
    </main>
  )
}

/** One end state: a serif title and one or two plain sentences. */
function EndState({ title, body }: { title: string; body: string | string[] }) {
  const lines = Array.isArray(body) ? body : [body]
  return (
    <div className="space-y-2">
      <h2 className="font-display text-xl tracking-tight">{title}</h2>
      {lines.map((line) => (
        <p key={line} className="text-[13px] text-muted-foreground" data-ph-mask="">
          {line}
        </p>
      ))}
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-muted-foreground">{t('fingerprint_label')}</span>
        <HelpPopover>{t('fingerprint_help')}</HelpPopover>
      </div>
      <p className="break-all font-mono text-[12.5px]">{full ? sha256 : sha256.slice(0, SHORT_FINGERPRINT)}</p>
      <button type="button" className={QUIET_LINK_CLASS} onClick={() => setFull((v) => !v)} aria-expanded={full}>
        {full ? t('fingerprint_short') : t('fingerprint_full')}
      </button>
    </div>
  )
}
