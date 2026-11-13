'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { ombudCheckOutcome, type OmbudCheckOutcome, type OmbudConnectionFacts } from '@/lib/skatteverket/ombud-appointment'
import { namedRetryAfterSeconds, ombudVerifyRetryDecision } from '@/lib/skatteverket/ombud-verify-retry'

/**
 * Appointing the app as the company's ombud at Skatteverket, shared by every
 * place that offers it (settings, the Hem chip and checklist, onboarding).
 * Skatteverket's e-service opens with the app pre-filled as ombud and the
 * roles pre-selected; the company only signs there with BankID. Nothing calls
 * back when they have signed, so the grant is checked against Skatteverket's
 * ombudsregister when the user returns to the page. The server asks the
 * register before it mints a link: a company that already appointed the app
 * (directly at Skatteverket, say) gets "already appointed" and no link.
 */

const BASE = '/api/extensions/ext/skatteverket/system-connection'

export type OmbudLinkResult =
  | { ok: true; alreadyAppointed: boolean }
  | { ok: false; error: string | null }

/**
 * Mint the deep link and open it. Call straight from a click handler: the tab
 * opens before the first await, so popup blockers allow it, and is pointed at
 * the link once the server has minted it. Already appointed: the tab closes
 * again and `alreadyAppointed` says so.
 */
export async function openOmbudDeepLink(locale: ErrorLocale = 'sv'): Promise<OmbudLinkResult> {
  // No 'noopener' feature: with it window.open returns null and the
  // pre-opened tab would never exist. The opener link is cut by hand.
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  try {
    const res = await fetch(`${BASE}/deeplink`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as {
      data?: { djuplank?: unknown; already_appointed?: unknown }
      error?: unknown
    }
    if (res.ok && body.data?.already_appointed === true) {
      tab?.close()
      return { ok: true, alreadyAppointed: true }
    }
    const url = typeof body.data?.djuplank === 'string' ? body.data.djuplank : null
    if (!res.ok || !url) {
      tab?.close()
      return { ok: false, error: body.error ? getErrorMessage(body, { locale }) : null }
    }
    // A blocked pre-open means a second window.open after the await would be
    // blocked too: navigate this tab instead so the link is never lost.
    if (tab) tab.location.href = url
    else window.location.assign(url)
    return { ok: true, alreadyAppointed: false }
  } catch {
    tab?.close()
    return { ok: false, error: null }
  }
}

/** What a check found (ombudCheckOutcome), or why it could not ask. */
export type OmbudVerifyResult = OmbudCheckOutcome | 'rate_limited' | 'failed'

/** One check's answer. `retryAfterSeconds`: the wait a rate-limit refusal named, when it named one. */
export interface OmbudVerifyOutcome {
  result: OmbudVerifyResult
  error: string | null
  retryAfterSeconds?: number | null
}

/** Ask the ombudsregister whether the company has appointed the app: the user is back from signing. */
export async function verifyOmbudGrant(locale: ErrorLocale = 'sv'): Promise<OmbudVerifyOutcome> {
  try {
    const res = await fetch(`${BASE}/verify`, { method: 'POST' })
    if (res.status === 429) {
      const refused = (await res.json().catch(() => ({}))) as { retry_after_seconds?: unknown }
      return { result: 'rate_limited', error: null, retryAfterSeconds: namedRetryAfterSeconds(refused.retry_after_seconds, res.headers.get('Retry-After')) }
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { connection?: OmbudConnectionFacts | null }
      error?: unknown
    }
    if (!res.ok) return { result: 'failed', error: body.error ? getErrorMessage(body, { locale }) : null }
    return { result: ombudCheckOutcome(body.data?.connection ?? null), error: null }
  } catch {
    return { result: 'failed', error: null }
  }
}

/** Resolves after `seconds`, or at once with false when `signal` aborts. */
function waitSeconds(seconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, seconds * 1000)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * verifyOmbudGrant that stays with a rate-limited check (for #206): when the
 * server says the register was asked within the minute, wait as long as it
 * named and ask again, a bounded number of times (ombudVerifyRetryDecision
 * holds the rule). `onWaiting` hears each wait as it starts, so the page can
 * say that it checks again. Past the bound the refusal is returned as it is
 * and the person asks again themselves. Null when `signal` aborted (the page
 * went away, or a new signing replaced this check): nothing to report.
 */
export async function verifyOmbudGrantWithRetries(
  locale: ErrorLocale,
  signal: AbortSignal,
  onWaiting: (seconds: number) => void,
): Promise<OmbudVerifyOutcome | null> {
  for (let retriesDone = 0; ; retriesDone += 1) {
    const outcome = await verifyOmbudGrant(locale)
    if (signal.aborted) return null
    if (outcome.result !== 'rate_limited') return outcome
    const decision = ombudVerifyRetryDecision({ retriesDone, retryAfterSeconds: outcome.retryAfterSeconds ?? null })
    if (!decision.retry) return outcome
    onWaiting(decision.waitSeconds)
    if (!(await waitSeconds(decision.waitSeconds, signal))) return null
  }
}

export type OmbudAppointOutcome = { result: OmbudVerifyResult | 'link_failed'; error: string | null }

/**
 * Appoint, then check once on return: `appoint()` opens the deep link, and the
 * next time this page becomes visible (the user is back from signing) the
 * grant is verified once and `onResult` hears the outcome. No polling: an
 * unfinished signature costs one register call per return, and the hourly
 * ombud sync finds a grant Skatteverket registers later. A company the server
 * finds already appointed hears 'granted' at once, with no tab and no check.
 *
 * A check the server paces (a 429) is not the end of it: it is asked again
 * after the wait the server named, a bounded number of times, and
 * `onWaiting` hears each wait so the surface can say so. `checking` covers
 * the whole of it; a new appoint, or leaving the page, drops a pending wait.
 */
export function useOmbudAppoint(onResult: (outcome: OmbudAppointOutcome) => void, onWaiting?: (seconds: number) => void) {
  const errorLocale = useLocale() as ErrorLocale
  const [linking, setLinking] = useState(false)
  const [checking, setChecking] = useState(false)
  const armed = useRef(false)
  const pending = useRef<AbortController | null>(null)
  const onResultRef = useRef(onResult)
  const onWaitingRef = useRef(onWaiting)
  useEffect(() => {
    onResultRef.current = onResult
    onWaitingRef.current = onWaiting
  }, [onResult, onWaiting])

  useEffect(() => {
    async function onVisible() {
      if (document.visibilityState !== 'visible' || !armed.current) return
      armed.current = false
      pending.current?.abort()
      const run = new AbortController()
      pending.current = run
      setChecking(true)
      const outcome = await verifyOmbudGrantWithRetries(errorLocale, run.signal, (seconds) => onWaitingRef.current?.(seconds))
      // Aborted: a newer check (or the unmount) owns the state now.
      if (!outcome) return
      pending.current = null
      setChecking(false)
      onResultRef.current({ result: outcome.result, error: outcome.error })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      pending.current?.abort()
      pending.current = null
    }
  }, [errorLocale])

  const appoint = useCallback(async () => {
    // A new signing replaces a check that is waiting out the pacing.
    pending.current?.abort()
    pending.current = null
    setChecking(false)
    setLinking(true)
    const opened = await openOmbudDeepLink(errorLocale)
    setLinking(false)
    if (!opened.ok) {
      onResultRef.current({ result: 'link_failed', error: opened.error })
      return
    }
    if (opened.alreadyAppointed) {
      onResultRef.current({ result: 'granted', error: null })
      return
    }
    armed.current = true
  }, [errorLocale])

  return { appoint, linking, checking }
}

/**
 * useOmbudAppoint with the shared toasts. `onVerified` hears every completed
 * check, so the surface can refresh what it shows (router.refresh on Hem and
 * in Kom igång, a state reload in settings).
 */
export function useOmbudAppointWithToasts(onVerified: (result: OmbudVerifyResult) => void) {
  const t = useTranslations('skatteverket_ombud')
  const { appName } = useBranding()
  const { toast } = useToast()
  const handle = useCallback(
    ({ result, error }: OmbudAppointOutcome) => {
      if (result !== 'link_failed') onVerified(result)
      switch (result) {
        case 'granted':
          toast({ title: t('granted', { appName }) })
          return
        case 'waiting':
          toast({ title: t('waiting'), description: t('waiting_hint', { appName }) })
          return
        case 'rate_limited':
          toast({ title: t('rate_limited') })
          return
        case 'link_failed':
          toast({ title: t('link_failed'), description: error ?? undefined, variant: 'destructive' })
          return
        default:
          toast({ title: t('verify_failed'), description: error ?? undefined, variant: 'destructive' })
      }
    },
    [appName, onVerified, t, toast],
  )
  const waiting = useCallback((seconds: number) => toast({ title: t('rate_limited_retrying', { seconds }) }), [t, toast])
  return useOmbudAppoint(handle, waiting)
}
