'use client'

import Script from 'next/script'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslations } from 'next-intl'
import {
  getTurnstileRolloutState,
  resolveTurnstileSiteKey,
} from '@/lib/auth/turnstile'

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

export type TurnstileAction =
  | 'accounted_login'
  | 'accounted_password_reset'
  | 'accounted_signup'
  | 'accounted_sandbox'

type TurnstileWidgetState = 'loading' | 'ready' | 'verified' | 'error'

type TurnstileRenderOptions = {
  sitekey: string
  action: TurnstileAction
  appearance: 'interaction-only'
  execution: 'render'
  size: 'compact'
  theme: 'auto'
  callback: (token: string) => void
  'error-callback': () => void
  'expired-callback': () => void
  'timeout-callback': () => void
}

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: TurnstileRenderOptions,
  ) => string | undefined
  remove: (widgetId: string) => void
  reset: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export type TurnstileChallengeHandle = {
  reset: () => void
}

type TurnstileChallengeProps = {
  action: TurnstileAction
  onTokenChange: (token: string | null) => void
}

export const TurnstileChallenge = forwardRef<
  TurnstileChallengeHandle,
  TurnstileChallengeProps
>(function TurnstileChallenge({ action, onTokenChange }, ref) {
  const t = useTranslations('auth')
  const siteKey = resolveTurnstileSiteKey()
  const rolloutState = getTurnstileRolloutState()
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const onTokenChangeRef = useRef(onTokenChange)
  const [widgetState, setWidgetState] = useState<TurnstileWidgetState>('loading')

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange
  }, [onTokenChange])

  const clearToken = useCallback((state: TurnstileWidgetState) => {
    onTokenChangeRef.current(null)
    setWidgetState(state)
  }, [])

  const reset = useCallback(() => {
    clearToken('ready')
    const widgetId = widgetIdRef.current
    if (!widgetId || !window.turnstile) return

    try {
      window.turnstile.reset(widgetId)
    } catch {
      clearToken('error')
    }
  }, [clearToken])

  useImperativeHandle(ref, () => ({ reset }), [reset])

  const renderWidget = useCallback(() => {
    if (!siteKey || !containerRef.current || !window.turnstile) return
    if (widgetIdRef.current) return

    try {
      setWidgetState('ready')
      const widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
        execution: 'render',
        size: 'compact',
        theme: 'auto',
        callback: (token) => {
          onTokenChangeRef.current(token)
          setWidgetState('verified')
        },
        'error-callback': () => clearToken('error'),
        'expired-callback': reset,
        'timeout-callback': reset,
      })
      if (!widgetId) {
        clearToken('error')
        return
      }
      widgetIdRef.current = widgetId
    } catch {
      clearToken('error')
    }
  }, [action, clearToken, reset, siteKey])

  useEffect(() => {
    return () => {
      const widgetId = widgetIdRef.current
      if (!widgetId || !window.turnstile) return
      try {
        window.turnstile.remove(widgetId)
      } catch {
        // The provider may already have removed an expired widget.
      }
      widgetIdRef.current = null
    }
  }, [])

  if (!siteKey) {
    return (
      <span
        aria-hidden="true"
        className="hidden"
        data-turnstile-rollout-state={rolloutState}
      />
    )
  }

  return (
    <div
      className="flex flex-col items-center gap-2"
      data-turnstile-rollout-state={rolloutState}
      data-turnstile-widget-state={widgetState}
    >
      <Script
        id="cloudflare-turnstile"
        src={TURNSTILE_SCRIPT_URL}
        strategy="afterInteractive"
        onReady={renderWidget}
        onError={() => clearToken('error')}
      />
      <div ref={containerRef} />
      {(widgetState === 'loading' || widgetState === 'ready') && (
        <p className="sr-only" role="status">
          {t('turnstile_checking')}
        </p>
      )}
      {widgetState === 'error' && (
        <p className="text-center text-xs text-destructive" role="alert">
          {t('turnstile_error')}
        </p>
      )}
    </div>
  )
})
