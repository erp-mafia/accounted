'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { GoogleMark } from '@/components/ui/provider-marks'


/**
 * "Continue with Google" for the login and register pages.
 *
 * Kicks off the Supabase OAuth redirect; the round-trip lands in
 * /auth/callback (PKCE code exchange), which owns MFA routing, invite
 * acceptance and silent-team creation for OAuth sign-ins and sign-ups alike.
 * The flow=oauth marker lets the callback tag failures so the login page
 * shows Google-specific copy instead of the email-confirmation framing.
 */
export function GoogleAuthButton({
  onError,
  compact = false,
  next,
}: {
  onError: (message: string) => void
  /**
   * Half-width alternative-method chip on the login panel: shows just the
   * mark and "Google" (a brand name, never translated), with the full label
   * kept as the accessible name.
   */
  compact?: boolean
  /**
   * Post-auth destination, already passed through safeReturnTo by the caller.
   * Forwarded to /auth/callback as `next` so an OAuth sign-in or sign-up that
   * started from the MCP consent page (/login?next=/api/mcp-oauth/authorize…)
   * resumes the consent flow instead of landing on the dashboard. '/' (the
   * safeReturnTo fallback) means no destination and is not forwarded.
   */
  next?: string
}) {
  const [isRedirecting, setIsRedirecting] = useState(false)
  const supabase = createClient()
  const tAuth = useTranslations('auth')
  const errorLocale = useLocale() as ErrorLocale

  const handleClick = async () => {
    setIsRedirecting(true)
    try {
      const callback = new URL('/auth/callback', window.location.origin)
      callback.searchParams.set('flow', 'oauth')
      if (next && next !== '/') callback.searchParams.set('next', next)
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callback.toString(),
        },
      })
      if (error) {
        onError(getErrorMessage(error, { context: 'auth', locale: errorLocale }))
        setIsRedirecting(false)
      }
      // On success the browser navigates away; keep the spinner until then.
    } catch (error) {
      onError(getErrorMessage(error, { context: 'auth', locale: errorLocale }))
      setIsRedirecting(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className={compact ? 'h-10 w-full gap-2' : 'w-full h-11'}
      onClick={handleClick}
      disabled={isRedirecting}
      aria-label={tAuth('continue_with_google')}
    >
      {isRedirecting ? (
        <Loader2 className={compact ? 'h-4 w-4 animate-spin' : 'mr-2 h-4 w-4 animate-spin'} />
      ) : (
        <span className={compact ? 'flex items-center' : 'mr-2 flex items-center'}>
          <GoogleMark />
        </span>
      )}
      {compact ? 'Google' : tAuth('continue_with_google')}
    </Button>
  )
}
