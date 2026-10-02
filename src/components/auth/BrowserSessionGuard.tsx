'use client'

import { useEffect, useState } from 'react'
import posthog from 'posthog-js'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import {
  authCookieNames,
  duplicateAuthCookieNames,
  scrubAuthCookies,
} from '@/lib/auth/browser-session-cookies'

/** Second look before telling the user: rides out a refresh racing the server's. */
const RECHECK_DELAY_MS = 3_000

type Probe = 'ok' | 'missing' | 'unknown'

async function probeBrowserSession(): Promise<Probe> {
  try {
    const { data, error } = await createClient().auth.getSession()
    if (data.session) return 'ok'
    // A network blip during refresh is not a lost session.
    if (error?.name === 'AuthRetryableFetchError') return 'unknown'
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'unknown'
    return 'missing'
  } catch {
    return 'unknown'
  }
}

/**
 * The dashboard only renders for a user the server has authenticated, so the
 * browser's own Supabase client must hold a session too. When it does not,
 * every direct browser read runs as anon and RLS returns empty lists, which
 * reads as "my bank and accounts are gone" (PH 99). The cause we have seen is
 * a duplicate auth cookie the server and browser parse differently; see
 * lib/auth/browser-session-cookies.ts. Say so instead of showing empty pages,
 * and offer a sign-in that removes every cookie variant first, which a plain
 * sign-out does not.
 */
export function BrowserSessionGuard() {
  const t = useTranslations('browser_session_guard')
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    void (async () => {
      if ((await probeBrowserSession()) !== 'missing' || cancelled) return
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RECHECK_DELAY_MS)
      })
      if (cancelled || (await probeBrowserSession()) !== 'missing' || cancelled) return

      if (isAnalyticsEnabled()) {
        try {
          // Counts only, never cookie values.
          posthog.capture('browser_session_missing', {
            auth_cookie_count: authCookieNames(document.cookie).length,
            duplicate_auth_cookie_count: duplicateAuthCookieNames(document.cookie).length,
          })
        } catch {
          // Telemetry must never affect the guard.
        }
      }
      setMissing(true)
    })()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  if (!missing) return null

  function handleSignInAgain() {
    resetAnalyticsIdentity()
    scrubAuthCookies(document, window.location)
    const url = new URL('/login', window.location.origin)
    const next = window.location.pathname + window.location.search
    if (next !== '/') url.searchParams.set('next', next)
    window.location.assign(url.toString())
  }

  return (
    <div
      role="alert"
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground"
    >
      <span className="text-center text-xs font-medium sm:text-sm">{t('message')}</span>
      <Button type="button" size="sm" onClick={handleSignInAgain}>
        {t('sign_in_again')}
      </Button>
    </div>
  )
}
