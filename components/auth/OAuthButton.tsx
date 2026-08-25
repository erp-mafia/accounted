'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Loader2, KeyRound } from 'lucide-react'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { GoogleMark, MicrosoftMark } from '@/components/ui/provider-marks'
import type { ResolvedProvider } from '@/lib/auth/gotrue-providers'

/**
 * Render the brand mark for a known provider, or a generic key icon for
 * custom OIDC providers.
 */
function ProviderMark({ provider }: { provider: ResolvedProvider }) {
  if (provider.id === 'google') return <GoogleMark />
  else if (provider.id === 'azure') return <MicrosoftMark />
  // Known providers without a dedicated mark show the first letter
  if (!provider.isCustom) {
    return (
      <span className="flex h-4 w-4 items-center justify-center text-[11px] font-bold text-muted-foreground">
        {provider.label.charAt(0)}
      </span>
    )
  }
  // Custom OIDC providers get a generic key icon
  return <KeyRound className="h-4 w-4 text-muted-foreground" />
}

/**
 * Generic OAuth login button. Works with any Supabase GoTrue provider.
 *
 * For known providers (Google, GitHub, etc.) the button shows the brand
 * name; for custom OIDC providers it shows "Sign in with SSO" style text.
 *
 * Kicks off the Supabase OAuth redirect, with flow=oauth so
 * /auth/callback can tag failures.
 */
export function OAuthButton({
  provider,
  onError,
  compact = false,
  next,
}: {
  provider: ResolvedProvider
  onError: (message: string) => void
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
        provider: provider.id as Parameters<typeof supabase.auth.signInWithOAuth>[0]['provider'],
        options: {
          redirectTo: callback.toString(),
        },
      })
      if (error) {
        onError(getErrorMessage(error, { context: 'auth', locale: errorLocale }))
        setIsRedirecting(false)
      }
    } catch (error) {
      onError(getErrorMessage(error, { context: 'auth', locale: errorLocale }))
      setIsRedirecting(false)
    }
  }

  const label = provider.isCustom
    ? tAuth('continue_with_sso')
    : tAuth('continue_with_provider', { provider: provider.label })

  return (
    <Button
      type="button"
      variant="outline"
      className={compact ? 'h-10 w-full gap-2' : 'w-full h-11'}
      onClick={handleClick}
      disabled={isRedirecting}
      aria-label={label}
    >
      {isRedirecting ? (
        <Loader2 className={compact ? 'h-4 w-4 animate-spin' : 'mr-2 h-4 w-4 animate-spin'} />
      ) : (
        <span className={compact ? 'flex items-center' : 'mr-2 flex items-center'}>
          <ProviderMark provider={provider} />
        </span>
      )}
      {compact ? (provider.isCustom ? tAuth('sso_chip') : provider.label) : label}
    </Button>
  )
}
