'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import { BankIdQrCode } from './BankIdQrCode'
import { Button } from '@/components/ui/button'
import { Smartphone, Monitor, AlertTriangle } from 'lucide-react'

type BankIdStatus = 'idle' | 'scanning' | 'complete' | 'failed' | 'no_account' | 'service_unavailable'

/** Max consecutive poll failures before we declare service unavailable */
const MAX_POLL_FAILURES = 3

interface BankIdSession {
  sessionId: string
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
  sessionId?: string
}

interface BankIdAuthProps {
  mode: 'login' | 'signup' | 'link'
  onComplete: (result: BankIdResult) => void
}

const API_BASE = '/api/extensions/ext/tic/bankid'

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

/**
 * sessionStorage key holding an in-flight BankID session across the mobile
 * return-redirect. On iOS the BankID app returns to the SAME Safari tab by
 * reloading it (see launchBankIdApp), which wipes React state, so we stash the
 * session here and resume polling on the next mount.
 */
const PENDING_KEY = 'bankid:pending'
/** Ignore a stashed session older than this (BankID orders expire in ~3 min). */
const PENDING_TTL_MS = 5 * 60 * 1000

interface PendingBankId {
  session: BankIdSession
  mode: string
  ts: number
}

function persistPending(session: BankIdSession, mode: string): void {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ session, mode, ts: Date.now() } satisfies PendingBankId)
    )
  } catch {
    // sessionStorage unavailable (private mode / quota): auto-resume just won't
    // fire; the user can still switch back to the tab manually as before.
  }
}

function readPending(mode: string): PendingBankId | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingBankId
    if (parsed?.mode !== mode) return null
    if (typeof parsed.ts !== 'number' || Date.now() - parsed.ts > PENDING_TTL_MS) return null
    if (!parsed.session?.sessionId) return null
    return parsed
  } catch {
    return null
  }
}

function clearPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // ignore
  }
}

/**
 * Launch the BankID app on the same (mobile) device.
 *
 * Uses the universal link https://app.bankid.com/: NOT the bankid:/// custom
 * scheme. A custom-scheme launch has no association with the originating Safari
 * tab, so on iOS the post-auth redirect opens in a NEW tab (git history: commit
 * 3bc652cc reverted a redirect for exactly that reason). The universal link is
 * tied to the originating tab, so BankID returns the user to it.
 *
 * redirect:
 *   • iOS     → current URL, so the app navigates this tab back here on success
 *               (the resume effect then completes the flow).
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
export function BankIdAuth({ mode, onComplete }: BankIdAuthProps) {
  const [status, setStatus] = useState<BankIdStatus>('idle')
  const [session, setSession] = useState<BankIdSession | null>(null)
  const [hintMessage, setHintMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastStartRef = useRef<number>(0)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const pollFailureCount = useRef(0)

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
  }, [])

  useEffect(() => cleanup, [cleanup])

  // Poll an in-flight BankID session until it completes, fails, or the service
  // gives up. Extracted from startSession so the resume effect (mobile return)
  // can re-attach to a session that was started before the tab reloaded.
  const beginPolling = useCallback((session: BankIdSession) => {
    abortRef.current = new AbortController()
    pollRef.current = setInterval(async () => {
      try {
        const pollRes = await fetch(`${API_BASE}/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: session.sessionId }),
          signal: abortRef.current?.signal,
        })

        if (!pollRes.ok) {
          const pollErr = await pollRes.json().catch(() => ({}))
          if (pollErr.error === 'service_unavailable' || pollRes.status === 502 || pollRes.status === 503) {
            pollFailureCount.current++
            if (pollFailureCount.current >= MAX_POLL_FAILURES) {
              cleanup()
              clearPending()
              setStatus('service_unavailable')
              setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
              onCompleteRef.current({ error: 'service_unavailable' })
            }
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

        // Handle token refresh (order regeneration ~25s)
        if (pollData.qrStartToken && pollData.qrStartSecret) {
          setSession((prev) =>
            prev
              ? { ...prev, qrStartToken: pollData.qrStartToken, qrStartSecret: pollData.qrStartSecret }
              : prev
          )
        }

        if (pollData.status === 'complete') {
          cleanup()
          clearPending()
          setStatus('complete')

          if (mode === 'login') {
            // For login, call /complete to exchange for Supabase session
            try {
              const completeRes = await fetch(`${API_BASE}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  sessionId: session.sessionId,
                  mode: 'login',
                }),
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
            // For link, call /link to associate BankID with current user
            try {
              const linkRes = await fetch(`${API_BASE}/link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: session.sessionId }),
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
            // For signup, return user data + sessionId so parent can collect email
            onCompleteRef.current({
              givenName: pollData.user?.givenName,
              surname: pollData.user?.surname,
              sessionId: session.sessionId,
            })
          }
        } else if (pollData.status === 'failed' || pollData.status === 'cancelled') {
          cleanup()
          clearPending()
          setStatus('failed')
          setErrorMessage(pollData.message || 'BankID-identifieringen misslyckades')
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        pollFailureCount.current++
        if (pollFailureCount.current >= MAX_POLL_FAILURES) {
          cleanup()
          clearPending()
          setStatus('service_unavailable')
          setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
          onCompleteRef.current({ error: 'service_unavailable' })
        }
      }
    }, 2000)
  }, [cleanup, mode])

  const startSession = useCallback(async () => {
    // Prevent rapid restarts (each start = billable TIC session)
    const now = Date.now()
    if (now - lastStartRef.current < 5000) return
    lastStartRef.current = now

    cleanup()
    clearPending()
    setStatus('scanning')
    setHintMessage('Starta BankID-appen')
    setErrorMessage('')

    try {
      const res = await fetch(`${API_BASE}/start`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (err.error === 'service_unavailable' || err.error === 'not_configured' || res.status === 502 || res.status === 503) {
          cleanup()
          setStatus('service_unavailable')
          setErrorMessage('BankID-tjänsten är inte tillgänglig just nu')
          onCompleteRef.current({ error: 'service_unavailable' })
          return
        }
        throw new Error(err.message || err.error || 'Failed to start BankID')
      }

      const { data } = await res.json()
      const newSession: BankIdSession = data
      setSession(newSession)

      // On mobile, open the BankID app on this device.
      if (isMobile()) {
        // Persist BEFORE launching: on iOS the BankID app returns by reloading
        // THIS tab (universal link → same tab), which wipes in-memory state.
        // The resume effect re-attaches polling on load. See launchBankIdApp.
        persistPending(newSession, mode)
        launchBankIdApp(newSession.autoStartToken)
      }

      beginPolling(newSession)
    } catch (error) {
      setStatus('failed')
      setErrorMessage(error instanceof Error ? error.message : 'Ett oväntat fel uppstod')
    }
  }, [cleanup, mode, beginPolling])

  // After returning from the BankID app on mobile, iOS reloads this tab. Pick up
  // the session we persisted before launching and resume polling so the flow
  // completes without the user having to tap "Logga in med BankID" again.
  useEffect(() => {
    const pending = readPending(mode)
    if (!pending) return
    setSession(pending.session)
    setStatus('scanning')
    setHintMessage('Slutför BankID-verifieringen...')
    beginPolling(pending.session)
    // Run once on mount: we're recovering state that the return-reload destroyed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCancel = useCallback(async () => {
    if (session) {
      fetch(`${API_BASE}/${session.sessionId}`, { method: 'DELETE' }).catch(() => {})
    }
    cleanup()
    clearPending()
    setStatus('idle')
    setSession(null)
  }, [session, cleanup])

  if (status === 'idle') {
    const label = mode === 'login'
      ? 'Logga in med BankID'
      : mode === 'link'
        ? 'Koppla BankID'
        : 'Skapa konto med BankID'

    return (
      <Button
        onClick={startSession}
        variant="outline"
        className="w-full gap-2 border-[1.5px] py-6 text-base"
      >
        <BankIdIcon />
        {label}
      </Button>
    )
  }

  if (status === 'service_unavailable') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              BankID är inte tillgängligt just nu
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-300">
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
              className="mt-1 h-auto px-0 py-0 text-xs text-amber-600 underline underline-offset-2 hover:text-amber-800 dark:text-amber-400"
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
          <Button
            onClick={openBankIdOnDevice}
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
          >
            <Monitor className="h-3.5 w-3.5" />
            BankID på den här enheten
          </Button>
        </>
      )}

      {isMobile() && (
        <div className="flex flex-col items-center gap-2">
          <Smartphone className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Öppnar BankID-appen...</p>
        </div>
      )}

      <p className="text-sm text-muted-foreground">{hintMessage}</p>

      <Button
        onClick={handleCancel}
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
      >
        Avbryt
      </Button>
    </div>
  )
}

function BankIdIcon() {
  return (
    <Image
      src="/logos/bankid-seeklogo.svg"
      alt="BankID"
      width={20}
      height={20}
      className="dark:invert"
    />
  )
}
