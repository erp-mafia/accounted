'use client'

import { useEffect } from 'react'
import { onBrowserSessionLost } from '@/lib/supabase/browser-session-token'
import {
  clearBrowserSessionState,
  onSignedOutElsewhere,
  reloadTo,
} from '@/lib/auth/session-client'

/**
 * Leaves the dashboard as soon as the server says the session is gone.
 *
 * The browser no longer holds a session of its own: its Supabase client asks
 * GET /api/auth/session-token for an access token, and the server answers
 * from the HttpOnly session cookie. So the browser and the server can no
 * longer disagree about who is signed in, which is what this guard used to
 * detect (PH 99: a duplicate auth cookie the two sides parsed differently,
 * the dashboard rendered for a user whose direct reads ran as anon).
 *
 * What remains is the plain case: the session ended while the page was open
 * (revoked from another device, expired refresh token). The token endpoint
 * answers 401, and instead of rendering empty lists the page clears what it
 * held and goes to /login, returning here after sign-in. A session-timeout
 * 401 is left to SessionTimeoutController, which signs out with its reason.
 * A 403 (an MFA step-up owed) goes to /mfa/verify the same way.
 *
 * A sign-out in another tab ends this tab's session too (they share the
 * cookie): that tab announces it, and this one clears what it held (token,
 * its own sessionStorage) and leaves for /login at once (CASA 6.6.1).
 */
export function BrowserSessionGuard() {
  useEffect(() => {
    let leaving = false
    const leave = (target: URL, clear: boolean) => {
      if (leaving) return
      leaving = true
      if (clear) clearBrowserSessionState()
      reloadTo(target.toString())
    }
    const back = () => window.location.pathname + window.location.search
    const stopLost = onBrowserSessionLost((reason) => {
      const url =
        reason === 'mfa_required'
          ? new URL('/mfa/verify', window.location.origin)
          : new URL('/login', window.location.origin)
      if (back() !== '/') url.searchParams.set(reason === 'mfa_required' ? 'returnTo' : 'next', back())
      leave(url, reason === 'unauthenticated')
    })
    const stopSignedOut = onSignedOutElsewhere(() => {
      leave(new URL('/login', window.location.origin), true)
    })
    return () => {
      stopLost()
      stopSignedOut()
    }
  }, [])

  return null
}
