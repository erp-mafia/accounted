'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useBranding } from '@/lib/branding/brand-context'
import { useToast } from '@/components/ui/use-toast'

/**
 * Appointing the app as the company's ombud at Skatteverket, shared by every
 * place that offers it (settings, the Hem chip and checklist, onboarding).
 * Skatteverket's e-service opens with the app pre-filled as ombud and the
 * roles pre-selected; the company only signs there with BankID. Nothing calls
 * back when they have signed, so the grant is checked against Skatteverket's
 * ombudsregister when the user returns to the page.
 */

const BASE = '/api/extensions/ext/skatteverket/system-connection'

export type OmbudLinkResult = { ok: true } | { ok: false; error: string | null }

/**
 * Mint the deep link and open it. Call straight from a click handler: the tab
 * opens before the first await, so popup blockers allow it, and is pointed at
 * the link once the server has minted it.
 */
export async function openOmbudDeepLink(): Promise<OmbudLinkResult> {
  // No 'noopener' feature: with it window.open returns null and the
  // pre-opened tab would never exist. The opener link is cut by hand.
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  try {
    const res = await fetch(`${BASE}/deeplink`, { method: 'POST' })
    const body = (await res.json().catch(() => ({}))) as { data?: { djuplank?: unknown }; error?: unknown }
    const url = typeof body.data?.djuplank === 'string' ? body.data.djuplank : null
    if (!res.ok || !url) {
      tab?.close()
      return { ok: false, error: typeof body.error === 'string' ? body.error : null }
    }
    // A blocked pre-open means a second window.open after the await would be
    // blocked too: navigate this tab instead so the link is never lost.
    if (tab) tab.location.href = url
    else window.location.assign(url)
    return { ok: true }
  } catch {
    tab?.close()
    return { ok: false, error: null }
  }
}

export type OmbudVerifyResult = 'granted' | 'not_yet' | 'rate_limited' | 'failed'

/** Ask the ombudsregister whether the company has appointed the app (läsombud decides). */
export async function verifyOmbudGrant(): Promise<{ result: OmbudVerifyResult; error: string | null }> {
  try {
    const res = await fetch(`${BASE}/verify`, { method: 'POST' })
    if (res.status === 429) return { result: 'rate_limited', error: null }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { connection?: { lasombud_status?: string } | null }
      error?: unknown
    }
    if (!res.ok) return { result: 'failed', error: typeof body.error === 'string' ? body.error : null }
    return { result: body.data?.connection?.lasombud_status === 'granted' ? 'granted' : 'not_yet', error: null }
  } catch {
    return { result: 'failed', error: null }
  }
}

export type OmbudAppointOutcome = { result: OmbudVerifyResult | 'link_failed'; error: string | null }

/**
 * Appoint, then check once on return: `appoint()` opens the deep link, and the
 * next time this page becomes visible (the user is back from signing) the
 * grant is verified once and `onResult` hears the outcome. No polling: an
 * unfinished signature costs one register call per return.
 */
export function useOmbudAppoint(onResult: (outcome: OmbudAppointOutcome) => void) {
  const [linking, setLinking] = useState(false)
  const [checking, setChecking] = useState(false)
  const armed = useRef(false)
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  useEffect(() => {
    async function onVisible() {
      if (document.visibilityState !== 'visible' || !armed.current) return
      armed.current = false
      setChecking(true)
      const outcome = await verifyOmbudGrant()
      setChecking(false)
      onResultRef.current(outcome)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const appoint = useCallback(async () => {
    setLinking(true)
    const opened = await openOmbudDeepLink()
    setLinking(false)
    if (!opened.ok) {
      onResultRef.current({ result: 'link_failed', error: opened.error })
      return
    }
    armed.current = true
  }, [])

  return { appoint, linking, checking }
}

/**
 * useOmbudAppoint with the shared toasts. `onVerified` hears every completed
 * check, so the surface can refresh what it shows (router.refresh on Hem when
 * granted, a state reload in settings either way).
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
        case 'not_yet':
          toast({ title: t('not_yet'), description: t('not_yet_hint', { appName }) })
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
  return useOmbudAppoint(handle)
}
