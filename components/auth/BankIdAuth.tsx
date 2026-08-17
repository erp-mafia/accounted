'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { BankIdQrCode } from './BankIdQrCode'
import { Button } from '@/components/ui/button'
import { Smartphone, Monitor, AlertTriangle, Loader2 } from 'lucide-react'

type BankIdStatus =
  | 'idle'
  | 'scanning'
  | 'complete'
  | 'failed'
  | 'no_account'
  | 'service_unavailable'
  /** A flow exists in this browser that this browsing context did not start. */
  | 'resumable'
  /** Avbryt pressed: waiting out /cancel before a new flow may be started. */
  | 'cancelling'

/** Max consecutive poll failures before we declare service unavailable */
const MAX_POLL_FAILURES = 3

/**
 * Abandon a session that never reaches a terminal state. Safety net for TIC
 * responses that carry no `status` (e.g. an expired-session 410 body): without
 * it the poll loop would spin forever on a dead QR code.
 */
const POLL_DEADLINE_MS = 6 * 60 * 1000

/** Min spacing between billable TIC session starts (mirrors the server cooldown). */
const START_COOLDOWN_MS = 5_000

/**
 * What the client is allowed to know about a BankID order. Note the absence
 * of a session id: it is a bearer credential for the holder's personnummer
 * and for a Supabase session, so it stays in a signed HttpOnly cookie the
 * server sets at /start (extensions/general/tic/lib/bankid-flow-cookie.ts).
 * The tokens below are the ones the BankID app and the QR code need, and
 * neither identifies anybody.
 */
interface BankIdSession {
  flowId: string
  autoStartToken: string
  qrStartToken: string
  qrStartSecret: string
}

export interface BankIdResult {
  tokenHash?: string
  type?: string
  isNewUser?: boolean
  error?: 'no_account' | 'already_linked' | 'session_invalid' | 'service_unavailable'
  givenName?: string
  surname?: string
  /** Non-secret id that binds this tab to the shared server-held flow. */
  flowId?: string
}

interface BankIdAuthProps {
  mode: 'login' | 'signup' | 'link'
  onComplete: (result: BankIdResult) => void
  /**
   * Render the idle button as the panel's primary action (filled pill) instead
   * of the default outline. Used by the login page, where BankID owns the
   * primary zone; register and settings keep the quieter outline.
   */
  hero?: boolean
}

const API_BASE = '/api/extensions/ext/tic/bankid'
const FLOW_ID_HEADER = 'x-bankid-flow-id'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

/**
 * Launch the BankID app on the same (mobile) device.
 *
 * Uses the universal link https://app.bankid.com/: NOT the bankid:/// custom
 * scheme. A custom-scheme launch has no association with the originating Safari
 * tab, so on iOS the post-auth redirect opens in a NEW tab (git history: commit
 * 3bc652cc reverted a redirect for exactly that reason).
 *
 * redirect:
 *   • iOS     → current URL, so the app navigates back here on success. In
 *               Safari that is this very tab; in a third-party browser or an
 *               in-app web view the OS hands the URL to the default browser
 *               and it lands in a NEW tab. Both work: the flow lives in a
 *               cookie, which every tab of the origin shares, so whichever tab
 *               the user ends up in simply polls and carries on.
 *   • Android → "null": the BankID app returns via the task stack, and a real
 *               redirect URL would spawn a new tab / Chrome instance instead.
 */
function launchBankIdApp(autoStartToken: string): void {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const redirect = isIOS ? encodeURIComponent(window.location.href) : 'null'
  window.location.href = `https://app.bankid.com/?autostarttoken=${autoStartToken}&redirect=${redirect}`
}

/**
 * BankID authentication flow component.
 * Handles QR code display (desktop) or app deep link (mobile),
 * polling, and result handling.
 */
export function BankIdAuth({ mode, onComplete, hero = false }: BankIdAuthProps) {
  const t = useTranslations('auth')
  const [status, setStatus] = useState<BankIdStatus>('idle')
  const [session, setSession] = useState<BankIdSession | null>(null)
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null)
  const [hintMessage, setHintMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [launchedApp, setLaunchedApp] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastStartRef = useRef<number>(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const pollFailureCount = useRef(0)
  /** True while a poll response is being processed: prevents overlapping ticks. */
  const pollInFlightRef = useRef(false)
  /** Set once a terminal poll result has been handled: the completion branch must run at most once. */
  const completedRef = useRef(false)
  /** When the current poll loop began, for the POLL_DEADLINE_MS cap. */
  const pollStartedAtRef = useRef(0)
  /** Bumped by cancel/unmount so an in-flight startSession stops touching state. */
  const startGenRef = useRef(0)
  /** True while startSession is running: collapses double-clicks into one billable session. */
  const startingRef = useRef(false)
  /**
   * True when this tab is polling a flow it did not start, on the strength of
   * the hint cookie alone. Decides how a 404 reads: nothing to resume (quietly
   * show the button) versus this tab's own order expiring (say so).
   */
  const resumedRef = useRef(false)
  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    pollFailureCount.current = 0
    pollInFlightRef.current = false
  }, [])

  useEffect(
    () => () => {
      startGenRef.current++
      cleanup()
    },
    [cleanup]
  )

  // Poll the flow this browser holds until it completes, fails, or the service
  // gives up. Extracted from startSession so the resume effect (the tab BankID
  // returned the user to) can attach to a flow it did not start.
  const beginPolling = useCallback((flowId: string) => {
    // Never leave a previous interval running: two loops would share
    // pollFailureCount and completedRef, and the orphan would eventually
    // declare a healthy session unavailable and clear the live one.
    cleanup()
    abortRef.current = new AbortController()
    pollStartedAtRef.current = Date.now()
    completedRef.current = false
    pollInFlightRef.current = false
    pollRef.current = setInterval(async () => {
      // Never process two ticks concurrently: a slow response overlapping the
      // next tick could otherwise run the completion branch twice (double
      // /complete → double generateLink, which invalidates the first magic
      // link and fails the login intermittently).
      if (pollInFlightRef.current || completedRef.current) return

      // Hard cap: a session that never reaches a terminal state (expired
      // order, TIC response without `status`) must not poll forever.
      if (Date.now() - pollStartedAtRef.current > POLL_DEADLINE_MS) {
        cleanup()
        setStatus('failed')
        setErrorMessage('BankID-sessionen löpte ut. Försök igen.')
        return
      }

      pollInFlightRef.current = true
      try {
        // The server reads the secret session from the cookie. The body and
        // non-secret header bind this polling loop to its mode and flow id.
        const pollRes = await fetch(`${API_BASE}/poll`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [FLOW_ID_HEADER]: flowId,
          },
          body: JSON.stringify({ mode }),
          signal: abortRef.current?.signal,
        })

        // The server says this browser holds no live flow: it finished in
        // another tab, was cancelled, or expired. Terminal, and NOT a service
        // failure, so settle instead of spinning until the deadline.
        //
        // Matched on the body code, not the bare status: 404 is also what the
        // extension dispatcher returns for an unknown route and what the CDN
        // returns mid-deploy, and treating those as "your session died" would
        // abandon a live order and cost a second billable one.
        if (pollRes.status === 404) {
          const reason = await pollRes.json().catch(() => null)
          if (reason?.error !== 'no_session') {
            pollFailureCount.current++
            return
          }

          completedRef.current = true
          cleanup()
          if (resumedRef.current) {
            // We only probed on the chance a flow existed. It does not, so
            // quietly offer the start button.
            setStatus('idle')
          } else {
            // This tab watched its own order die. Say so: silently reverting to
            // the start button reads as "it just did nothing".
            setStatus('failed')
            setErrorMessage('BankID-sessionen löpte ut. Försök igen.')
          }
          setSession(null)
          setActiveFlowId(null)
          return
        }

        if (!pollRes.ok) {
          // Count EVERY failed poll (5xx, 429, unexpected 4xx): errors that
          // never increment the counter would otherwise leave the user
          // silently polling a dead session forever.
          pollFailureCount.current++
          if (pollFailureCount.current >= MAX_POLL_FAILURES) {
            cleanup()
            setStatus('service_unavailable')
            setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
            onCompleteRef.current({ error: 'service_unavailable' })
          }
          return
        }

        // Reset failure counter on successful poll
        pollFailureCount.current = 0

        const pollJson = await pollRes.json()
        const pollData = pollJson.data

        if (!pollData) {
          console.warn('[bankid] poll returned no data:', pollJson)
          return
        }

        // Update hint message from TIC API
        if (pollData.message) {
          setHintMessage(pollData.message)
        }

        // Token refresh (the order regenerates roughly every 25s). Adopted
        // even when this tab has no session of its own: that is how a resumed
        // tab (a reload, or the tab BankID returned the user to) gets a
        // renderable QR code instead of a spinner with nothing under it.
        if (pollData.qrStartToken && pollData.qrStartSecret) {
          setSession((prev) => ({
            flowId,
            autoStartToken: prev?.autoStartToken ?? '',
            qrStartToken: pollData.qrStartToken,
            qrStartSecret: pollData.qrStartSecret,
          }))
        }

        if (pollData.status === 'complete') {
          completedRef.current = true
          cleanup()
          setStatus('complete')

          if (mode === 'login') {
            // For login, call /complete to exchange for Supabase session.
            // Session and mode come from the flow cookie; the server clears it
            // as it answers, so this is single-use and a second tab that also
            // saw 'complete' gets session_invalid rather than minting a rival
            // magic link that would invalidate this one.
            try {
              const completeRes = await fetch(`${API_BASE}/complete`, {
                method: 'POST',
                headers: { [FLOW_ID_HEADER]: flowId },
              })
              const completeJson = await completeRes.json()

              if (!completeRes.ok) {
                const errorCode = completeJson.error === 'service_unavailable' || completeRes.status === 502 || completeRes.status === 503
                  ? 'service_unavailable' as const
                  : completeJson.error
                if (errorCode === 'service_unavailable') {
                  setStatus('service_unavailable')
                  setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
                }
                onCompleteRef.current({
                  error: errorCode,
                  givenName: completeJson.givenName,
                  surname: completeJson.surname,
                })
                return
              }

              onCompleteRef.current({
                tokenHash: completeJson.data.tokenHash,
                type: completeJson.data.type,
                isNewUser: completeJson.data.isNewUser,
              })
            } catch {
              onCompleteRef.current({ error: 'session_invalid' })
            }
          } else if (mode === 'link') {
            // For link, call /link to associate BankID with current user. The
            // server requires the flow cookie to have been opened in 'link'
            // mode, so a session started to sign someone in cannot be turned
            // into a binding against whoever is logged in here.
            try {
              const linkRes = await fetch(`${API_BASE}/link`, {
                method: 'POST',
                headers: { [FLOW_ID_HEADER]: flowId },
              })
              const linkJson = await linkRes.json()

              if (!linkRes.ok) {
                onCompleteRef.current({ error: linkJson.error })
                return
              }

              onCompleteRef.current({})
            } catch {
              onCompleteRef.current({ error: 'session_invalid' })
            }
          } else {
            // For signup, hand the parent the verified name so it can collect
            // an e-mail. The flow itself stays in the cookie, so the parent
            // posts only that e-mail to /complete.
            onCompleteRef.current({
              givenName: pollData.user?.givenName,
              surname: pollData.user?.surname,
              flowId,
            })
          }
        } else if (pollData.status === 'failed' || pollData.status === 'cancelled') {
          completedRef.current = true
          cleanup()
          setStatus('failed')
          setErrorMessage(pollData.message || 'BankID-identifieringen misslyckades')
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        pollFailureCount.current++
        if (pollFailureCount.current >= MAX_POLL_FAILURES) {
          cleanup()
          setStatus('service_unavailable')
          setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
          onCompleteRef.current({ error: 'service_unavailable' })
        }
      } finally {
        pollInFlightRef.current = false
      }
    }, 2000)
  }, [cleanup, mode])

  const startSession = useCallback(async () => {
    // Collapse double-clicks: one billable TIC session per intent.
    if (startingRef.current) return
    startingRef.current = true
    const gen = ++startGenRef.current

    cleanup()
    resumedRef.current = false
    setActiveFlowId(null)
    setLaunchedApp(false)
    setStatus('scanning')
    setHintMessage('Starta BankID-appen')
    setErrorMessage('')

    try {
      // Respect the billable-session cooldown by waiting out the remainder
      // instead of silently dropping the click: a retry button that does
      // nothing reads as "BankID is broken". Also keeps us under the
      // server-side per-IP cooldown on /start.
      const sinceLast = Date.now() - lastStartRef.current
      if (sinceLast < START_COOLDOWN_MS) {
        await new Promise((resolve) => setTimeout(resolve, START_COOLDOWN_MS - sinceLast))
      }
      if (gen !== startGenRef.current) return // cancelled/unmounted while waiting
      lastStartRef.current = Date.now()

      // The mode is pinned server-side into the flow cookie, so the session
      // this opens can only ever be finished as this kind of flow.
      const res = await fetch(`${API_BASE}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (gen !== startGenRef.current) return

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.error === 'service_unavailable' || err.error === 'not_configured' || res.status === 502 || res.status === 503) {
          cleanup()
          setStatus('service_unavailable')
          setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
          onCompleteRef.current({ error: 'service_unavailable' })
          return
        }
        if (res.status === 429 || err.error === 'rate_limit') {
          setStatus('failed')
          setErrorMessage('För många försök. Vänta en stund och försök igen.')
          return
        }
        // Unknown error: server messages are not user-facing copy; keep the
        // detail in the console and show Swedish.
        console.error('[bankid] start failed', res.status, err)
        setStatus('failed')
        setErrorMessage('Ett oväntat fel uppstod. Försök igen.')
        return
      }

      const { data } = await res.json()
      const newSession: BankIdSession = data
      setSession(newSession)
      setActiveFlowId(newSession.flowId)

      // On mobile, open the BankID app on this device. Nothing needs saving
      // first: /start already set the flow cookie, and a cookie is shared by
      // every tab of the origin, so whichever tab BankID returns the user to
      // (this one reloaded, or a brand new one) can resume from it.
      if (isMobile()) {
        setLaunchedApp(true)
        launchBankIdApp(newSession.autoStartToken)
      }

      beginPolling(newSession.flowId)
    } catch (error) {
      if (gen !== startGenRef.current) return
      console.error('[bankid] start failed', error)
      setStatus('failed')
      setErrorMessage('Ett oväntat fel uppstod. Försök igen.')
    } finally {
      startingRef.current = false
    }
  }, [cleanup, mode, beginPolling])

  /**
   * Start (or continue) polling the flow this browser holds. Called from the
   * "Fortsätt" confirm button and from startSession, never automatically on
   * mount: see the probe effect below for why.
   */
  const resumePolling = useCallback(() => {
    if (!activeFlowId) return
    resumedRef.current = true
    setStatus('scanning')
    setHintMessage(t('bankid_resume_hint'))
    beginPolling(activeFlowId)
  }, [activeFlowId, beginPolling, t])

  /**
   * On mount, ask ONCE whether this browser is mid-flow, and if so present a
   * confirm card rather than continuing automatically.
   *
   * This is the fix for the reported bug and the safe shape for it. BankID does
   * not reliably return the user to the tab that started the flow: on iOS
   * outside plain Safari the redirect opens a NEW tab, and even the same tab is
   * reloaded. The flow lives in a shared cookie now, so any of those tabs can
   * pick it up. But a shared cookie plus a shared machine means the tab that
   * finds a completed identification cannot prove the person sitting at it is
   * the one who made it: nothing the client can store survives an iOS reload
   * yet dies on "reopen closed tab" / session restore / tab duplication, so a
   * completed flow could otherwise be auto-consumed by the next person to open
   * the page and sign them into, or bind their account to, a stranger.
   *
   * So a resume is never automatic: a found flow routes to the confirm card
   * ("Fortsätt bara om det var du"), and only that click consumes it. The cost
   * is one tap after returning from the BankID app on iOS, which is where the
   * reported bug lives; desktop QR (no reload) and Android (returns to the live
   * tab) never hit this path and are unchanged. `link` never resumes at all.
   */
  useEffect(() => {
    if (mode === 'link') return
    let cancelled = false
    const gen = startGenRef.current

    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, probe: true }),
        })
        // No live flow this browser can point to (no cookie, or one for a
        // different mode): leave the start button.
        if (cancelled || res.status === 404 || !res.ok) return
        const json = await res.json().catch(() => null)
        const status = json?.data?.status
        if (!status || status === 'failed' || status === 'cancelled') return
        // A start begun while the probe was in flight owns the panel; do not
        // override it with a confirm card for the flow it is replacing.
        if (cancelled || gen !== startGenRef.current || startingRef.current) return

        // A live flow exists. It may be this person returning from the BankID
        // app, or a stranger's identification left on a shared machine; the two
        // are indistinguishable from here, so it is theirs to confirm, never
        // ours to spend. The probe deliberately gets no holder name from /poll,
        // so the card cannot reveal whose identification it is.
        const flowId = json?.data?.flowId
        if (typeof flowId !== 'string' || !flowId) return
        setActiveFlowId(flowId)
        setStatus('resumable')
      } catch {
        // Offline or a blip: leave the start button. A flow that really is
        // live will still be there when they press it (or on the next load).
      }
    })()

    return () => {
      cancelled = true
    }
    // Mount only: we are asking whether this browser is mid-flow, which cannot
    // change without one of this component's own actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCancel = useCallback(async () => {
    startGenRef.current++ // stop an in-flight startSession from resuming
    cleanup()
    setSession(null)
    // Hold a 'cancelling' state until /cancel resolves, rather than going
    // straight to 'idle'. /cancel clears the flow cookie with an UNTARGETED
    // Set-Cookie, and it round-trips to TIC before responding, so if the start
    // button were reachable now the user could open a new flow whose fresh
    // cookie the late clear would then delete. No start button is rendered in
    // 'cancelling', so a new /start cannot race the clear.
    setStatus('cancelling')
    try {
      await fetch(`${API_BASE}/cancel`, {
        method: 'POST',
        headers: activeFlowId ? { [FLOW_ID_HEADER]: activeFlowId } : undefined,
      })
    } catch {
      // Unreachable server: the flow expires on its own.
    } finally {
      setActiveFlowId(null)
      setStatus('idle')
    }
  }, [activeFlowId, cleanup])

  if (status === 'cancelling') {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('bankid_cancelling')}
      </div>
    )
  }

  if (status === 'resumable') {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('bankid_resume_title')}</p>
            <p className="text-sm text-muted-foreground">
              {/* Deliberately does not say who: naming the holder would leak a
                  stranger's identity to whoever sits down at a shared machine.
                  Signup shows the verified name on the next step, after the
                  person here has claimed the identification as theirs. */}
              {t('bankid_resume_description')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={resumePolling} variant="default" className="h-11 gap-2">
              <BankIdIcon className="invert dark:invert-0" />
              {t('bankid_resume_continue')}
            </Button>
            <Button onClick={handleCancel} variant="outline" className="h-11">
              {t('bankid_resume_restart')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'complete') {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('bankid_completing')}
      </div>
    )
  }

  if (status === 'idle') {
    const label = mode === 'login'
      ? 'Logga in med BankID'
      : mode === 'link'
        ? 'Koppla BankID'
        : 'Skapa konto med BankID'

    return (
      <Button
        onClick={startSession}
        variant={hero ? 'default' : 'outline'}
        className={hero ? 'h-11 w-full gap-2' : 'w-full gap-2 border-[1.5px] py-6 text-base'}
      >
        {/* On the filled pill the logo must counter-invert: primary is dark in
            light mode (white logo) and light in dark mode (black logo). */}
        <BankIdIcon className={hero ? 'invert dark:invert-0' : undefined} />
        {label}
      </Button>
    )
  }

  if (status === 'service_unavailable') {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attn" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium">
              BankID är inte tillgängligt just nu
            </p>
            <p className="text-sm text-muted-foreground">
              {mode === 'login'
                ? 'Logga in med e-post och lösenord nedan, eller använd "Glömt lösenord?" för en inloggningslänk via e-post.'
                : mode === 'signup'
                  ? 'Skapa konto med e-post och lösenord nedan istället.'
                  : 'Försök igen senare.'}
            </p>
            <Button
              onClick={startSession}
              variant="ghost"
              size="sm"
              className="mt-1 h-auto px-0 py-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Försök med BankID igen
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-destructive">{errorMessage}</p>
        <Button onClick={startSession} variant="outline" className="gap-2">
          <BankIdIcon />
          Försök igen
        </Button>
      </div>
    )
  }

  const openBankIdOnDevice = () => {
    if (!session) return
    // Open BankID app on the same device via deep link
    // redirect=null tells BankID not to redirect after completion
    window.location.href = `bankid:///?autostarttoken=${session.autoStartToken}&redirect=null`
  }

  // Scanning / waiting for user
  return (
    <div className="flex flex-col items-center gap-4">
      {session && !isMobile() && (
        <>
          <BankIdQrCode
            qrStartToken={session.qrStartToken}
            qrStartSecret={session.qrStartSecret}
          />
          {/* A resumed tab never called /start, so it has the rotating QR
              tokens but no autostart token. Rendering the button anyway would
              deep-link `autostarttoken=` empty, which does nothing and says
              nothing. The QR above still works. */}
          {session.qrStartToken && session.qrStartSecret && session.autoStartToken && (
            <Button
              onClick={openBankIdOnDevice}
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
            >
              <Monitor className="h-3.5 w-3.5" />
              BankID på den här enheten
            </Button>
          )}
        </>
      )}

      {isMobile() && (
        <div className="flex flex-col items-center gap-2">
          <Smartphone className="h-8 w-8 text-muted-foreground" />
          {/* A resumed tab never launched anything, so saying "opening the
              BankID app" would be a lie followed by silence. */}
          <p className="text-sm text-muted-foreground">
            {launchedApp
              ? 'Öppnar BankID-appen...'
              : t('bankid_finish_in_app')}
          </p>
        </div>
      )}

      <p className="text-sm text-muted-foreground">{hintMessage}</p>

      <Button
        onClick={handleCancel}
        disabled={!activeFlowId}
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
      >
        Avbryt
      </Button>
    </div>
  )
}

function BankIdIcon({ className }: { className?: string }) {
  return (
    <Image
      src="/logos/bankid-seeklogo.svg"
      alt="BankID"
      width={20}
      height={20}
      loading="eager"
      className={className ?? 'dark:invert'}
    />
  )
}
