'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { AttnLine } from '@/components/ui/attn-line'
import {
  Loader2,
  Mail,
  ArrowLeft,
  KeyRound,
  ExternalLink,
  CircleAlert,
  Eye,
  EyeOff,
} from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import { useBranding } from '@/lib/branding/brand-context'
import { SourceCodeFooter } from '@/components/branding/SourceCodeFooter'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { resolvePostLoginDestination } from '@/lib/company/post-login-landing'
import {
  consumeInviteCookie,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'
import { buildPasswordResetRedirectTo } from '@/lib/domains/trusted-app-origin'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { OAuthButton } from '@/components/auth/OAuthButton'
import {
  TurnstileChallenge,
  type TurnstileChallengeHandle,
} from '@/components/auth/TurnstileChallenge'
import {
  captchaTokenOptions,
  isTurnstileSubmissionBlocked,
} from '@/lib/auth/turnstile'
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { persistLoginMethodHint, type LoginMethod } from '@/lib/auth/login-method'
import {
  isSessionAuthMethod,
  setSessionAuthMethodHint,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'
import type { GoTrueAuthSettings } from '@/lib/auth/gotrue-providers'

import type { BankIdResult } from '@/components/auth/BankIdAuth'

const BankIdAuth = dynamic(
  () => import('@/components/auth/BankIdAuth').then((module) => module.BankIdAuth),
  { ssr: false },
)

/**
 * The login panel shows one method at a time (the pattern Swedish users know
 * from banks, Kivra and Fortnox): a primary zone owned by the active method,
 * and the remaining methods as quiet half-width chips under a single divider.
 * `initialMethod` comes from the server page reading the method-hint cookie,
 * so a returning password user lands straight on the form with no flash.
 */
export function LoginClient({
  initialMethod,
  authSettings,
  canUseSaml
}: {
  initialMethod: LoginMethod | null
  authSettings: GoTrueAuthSettings
  canUseSaml?: boolean
}) {
  const { providers, passwordLoginEnabled, registrationEnabled, samlEnabled } = authSettings
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isEmailSent, setIsEmailSent] = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [resetCooldownUntil, setResetCooldownUntil] = useState<number | null>(null)
  const [resetCooldownRemaining, setResetCooldownRemaining] = useState(0)
  const [bankIdNoAccount, setBankIdNoAccount] = useState<{ givenName?: string; surname?: string } | null>(null)
  const [bankIdUnavailable, setBankIdUnavailable] = useState(false)
  // Auth failures render inline (see AuthFormError / the field error line),
  // never as a toast: `kind` drives field highlighting and the recovery action.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind | 'bankid' | 'oauth'; message: string } | null>(null)
  // Consecutive credential failures; from the second one on, the error line
  // grows a reset-password action (extra help on repeated errors).
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [passwordCaptchaToken, setPasswordCaptchaToken] = useState<string | null>(null)
  const [resetCaptchaToken, setResetCaptchaToken] = useState<string | null>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const passwordTurnstileRef = useRef<TurnstileChallengeHandle>(null)
  const resetTurnstileRef = useRef<TurnstileChallengeHandle>(null)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackError = searchParams.get('error')
  const callbackFlow = searchParams.get('flow')
  const reasonParam = searchParams.get('reason')
  const timeoutReason: SessionTimeoutReason | null =
    reasonParam === 'idle' || reasonParam === 'absolute' ? reasonParam : null
  const methodParam = searchParams.get('method')
  const requestedMethod = isSessionAuthMethod(methodParam) ? methodParam : 'password'
  // Post-login destination, set e.g. by the MCP OAuth authorize endpoint
  // (/login?next=/api/mcp-oauth/authorize?...). Sanitized to a same-origin
  // relative path; '/' means no explicit destination.
  const nextPath = safeReturnTo(searchParams.get('next'), '/')
  // A visitor who arrives here from the MCP consent page and has no account
  // yet must be able to sign up without losing that destination (issue
  // #1814). The register page re-sanitises it through safeReturnTo.
  const registerHref = nextPath === '/' ? '/register' : `/register?next=${encodeURIComponent(nextPath)}`
  const supabase = createClient()
  const bankIdEnabled = isBankIdEnabled()
  // Per-request brand merged over getBranding() defaults (WL-12): identical
  // values on default hosts, brand values on branded hosts.
  const branding = useBranding()
  const tAuth = useTranslations('auth')
  const tCommon = useTranslations('common')
  const tInvite = useTranslations('invite')
  const errorLocale = useLocale() as ErrorLocale

  // Which method owns the panel. A session-timeout re-login follows the method
  // that timed out; otherwise the cookie hint wins; a fresh visitor starts on
  // BankID (the Swedish default) when it is enabled.
  const [method, setMethod] = useState<LoginMethod>(() => {
    if (!bankIdEnabled) return 'email'
    if (timeoutReason) return requestedMethod === 'bankid' ? 'bankid' : 'email'
    if (initialMethod) return initialMethod
    return 'bankid'
  })
  const prevMethodRef = useRef(method)

  useEffect(() => {
    if (timeoutReason) resetAnalyticsIdentity()
  }, [timeoutReason])

  // After a failed credentials attempt, put the caret back in the password
  // field with the old value selected so the user can retype immediately.
  // Runs post-render: the inputs are disabled while the request is in flight.
  useEffect(() => {
    if (formError?.kind === 'invalid_credentials') {
      passwordInputRef.current?.focus()
      passwordInputRef.current?.select()
    }
  }, [formError])

  // Switching to the email form should land the caret in the first field.
  useEffect(() => {
    if (prevMethodRef.current !== method) {
      prevMethodRef.current = method
      if (method === 'email') emailInputRef.current?.focus()
    }
  }, [method])

  const switchMethod = (next: LoginMethod) => {
    setFormError(null)
    setMethod(next)
  }

  const openResetForm = () => {
    setFormError(null)
    setResetCaptchaToken(null)
    setShowResetPassword(true)
  }

  const closeResetForm = () => {
    setFormError(null)
    setResetCaptchaToken(null)
    setShowResetPassword(false)
  }

  const handleSamlLogin = async () => {
    setFormError(null)
    setIsLoading(true)
    try {
      const ssoDomain = process.env.NEXT_PUBLIC_SSO_DOMAIN
      const ssoProviderId = process.env.NEXT_PUBLIC_SSO_PROVIDER_ID
      const params = ssoProviderId
        ? { providerId: ssoProviderId }
        : ssoDomain
          ? { domain: ssoDomain }
          : null
      if (!params) {
        setFormError({ kind: 'oauth', message: tAuth('saml_no_domain') })
        return
      }
      const { error } = await supabase.auth.signInWithSSO({
        ...params,
        options: { redirectTo: `${window.location.origin}/auth/callback?flow=oauth&next=${encodeURIComponent(nextPath)}` },
      })
      if (error) {
        setFormError({ kind: 'oauth', message: getErrorMessage(error, { context: 'auth', locale: errorLocale }) })
      }
    } catch (error) {
      setFormError({
        kind: 'oauth',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Accept a pending invite, if any, and report a non-definitive failure.
  // Returns true when the caller should land the user in the app directly.
  // The invite cookie survives anything that is not a settled outcome, so
  // /onboarding and /select-company can retry acceptance server-side.
  const acceptPendingInvite = async (): Promise<boolean> => {
    const invite = await consumeInviteCookie()
    if (invite.accepted) return true
    if (invite.problem) {
      const keys = INVITE_PROBLEM_MESSAGE_KEYS[invite.problem]
      toast({
        title: tInvite(keys.title),
        description: tInvite(keys.body),
        variant: 'destructive',
      })
    }
    return false
  }

  // Reset cooldown timer
  useEffect(() => {
    if (!resetCooldownUntil) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((resetCooldownUntil - Date.now()) / 1000))
      setResetCooldownRemaining(remaining)
      if (remaining <= 0) setResetCooldownUntil(null)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [resetCooldownUntil])

  const handleBankIdComplete = async (result: BankIdResult) => {
    if (result.error === 'no_account') {
      setBankIdNoAccount({ givenName: result.givenName, surname: result.surname })
      setMethod('email')
      return
    }

    if (result.error === 'service_unavailable') {
      setBankIdUnavailable(true)
      setMethod('email')
      return
    }

    if (result.error) {
      setFormError({ kind: 'bankid', message: tAuth('login_failed_bankid') })
      return
    }

    if (result.tokenHash && result.type) {
      try {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: result.tokenHash,
          type: result.type as 'magiclink',
        })

        if (error) {
          console.error('[login] BankID verifyOtp failed', error)
          setFormError({ kind: 'bankid', message: tAuth('login_failed_bankid') })
          return
        }

        setSessionAuthMethodHint('bankid')
        persistLoginMethodHint('bankid')

        // Check for pending invite token
        if (await acceptPendingInvite()) {
          window.location.href = '/'
          return
        }

        if (nextPath !== '/') {
          // An explicit destination (e.g. the MCP OAuth consent page, raw
          // HTML from a route handler) outranks the company picker.
          window.location.assign(nextPath)
          return
        }

        // Byrå staff on their byrå's home domain land in the cockpit
        // (WL-14). Everyone else keeps the picker: landing on
        // /select-company after BankID is deliberate, so the user sees
        // fresh CompanyRoles fetched during this session's enrichment
        // (and any failure inside the helper degrades to it).
        const dest = await resolvePostLoginDestination()
        router.push(dest === '/clients' ? '/clients' : '/select-company')
        router.refresh()
      } catch (error) {
        console.error('[login] BankID complete error', error)
        setFormError({
          kind: 'bankid',
          message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        })
      }
    }
  }

  const handlePasswordLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)

    if (isTurnstileSubmissionBlocked(passwordCaptchaToken)) {
      setFormError({ kind: 'unknown', message: tAuth('turnstile_required') })
      return
    }

    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailValue,
        password: passwordValue,
        options: captchaTokenOptions(passwordCaptchaToken),
      })

      if (error) {
        const kind = classifyAuthError(error)
        const messageByKind: Partial<Record<AuthErrorKind, string>> = {
          invalid_credentials: tAuth('login_invalid_credentials'),
          email_not_confirmed: tAuth('login_error_email_not_confirmed'),
          rate_limited: tAuth('login_error_rate_limited'),
          user_banned: tAuth('login_error_user_banned'),
        }
        if (kind === 'invalid_credentials') {
          setFailedAttempts((count) => count + 1)
        }
        setFormError({
          kind,
          message:
            messageByKind[kind] ??
            getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        })
        return
      }

      setSessionAuthMethodHint('password')
      persistLoginMethodHint('email')

      // Check MFA status
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()

      if (aal?.nextLevel === 'aal2' && aal?.currentLevel === 'aal1') {
        router.push(
          nextPath === '/'
            ? '/mfa/verify'
            : `/mfa/verify?returnTo=${encodeURIComponent(nextPath)}`
        )
        return
      }

      // Check for pending invite token
      if (await acceptPendingInvite()) {
        window.location.href = '/'
        return
      }

      if (nextPath !== '/') {
        // Full navigation: the destination can be a route handler that
        // returns raw HTML (the MCP OAuth consent page), which the client
        // router cannot render.
        window.location.assign(nextPath)
        return
      }

      // Byrå staff land in the cockpit on their byrå's home domain (WL-14);
      // everyone else resolves to '/' and keeps today's flow byte-identically
      // (any failure inside the helper also degrades to '/').
      router.push(await resolvePostLoginDestination())
      router.refresh()
    } catch (error) {
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      passwordTurnstileRef.current?.reset()
      setIsLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)

    if (isTurnstileSubmissionBlocked(resetCaptchaToken)) {
      setFormError({ kind: 'unknown', message: tAuth('turnstile_required') })
      return
    }

    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailValue, {
        redirectTo: buildPasswordResetRedirectTo(window.location.origin),
        ...captchaTokenOptions(resetCaptchaToken),
      })

      if (error) {
        const kind = classifyAuthError(error)
        setFormError({
          kind,
          message:
            kind === 'rate_limited'
              ? tAuth('login_error_rate_limited')
              : getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        })
        return
      }

      // The full-screen "check your email" confirmation below is the
      // feedback; no toast needed on top of it.
      setEmail(emailValue)
      setResetCooldownUntil(Date.now() + 60_000)
      setIsEmailSent(true)
    } catch (error) {
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      resetTurnstileRef.current?.reset()
      setIsLoading(false)
    }
  }

  // Credential/form failures attach to the form; BankID and Google failures
  // belong to the panel (they originate outside the fields).
  const panelError = formError && (formError.kind === 'bankid' || formError.kind === 'oauth')
    ? formError
    : null
  const formLevelError = formError && !panelError ? formError : null

  // Email sent confirmation screen
  if (isEmailSent) {
    const webmailHint = detectWebmailHint(email, branding.authEmailFrom)

    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl tracking-tight">{tAuth('email_sent_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {showResetPassword
                ? tAuth.rich('email_sent_body_reset', {
                    email,
                    strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                  })
                : tAuth.rich('email_sent_body_login', {
                    email,
                    strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                  })}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {showResetPassword ? tAuth('email_sent_hint_reset') : tAuth('email_sent_hint_login')}
            </p>
          </div>

          <div className="space-y-2">
            {webmailHint && (
              <Button className="w-full" asChild>
                <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                  {tAuth(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                    provider: webmailHint.name,
                  })}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => {
                setIsEmailSent(false)
                setShowResetPassword(false)
              }}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {tCommon('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Reset password form
  if (showResetPassword) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-10">
            <div className="flex justify-center mb-4">
              <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
                <KeyRound className="h-7 w-7 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl tracking-tight">{tAuth('reset_title')}</h1>
            <p className="text-muted-foreground text-sm mt-2">
              {tAuth('reset_subtitle')}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-6">
            <form onSubmit={handleResetPassword} className="space-y-4">
              {formError && <AuthFormError message={formError.message} />}
              <div className="space-y-2">
                <Label htmlFor="email">{tAuth('email_label')}</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder={tAuth('email_placeholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
              </div>
              <TurnstileChallenge
                ref={resetTurnstileRef}
                action="accounted_password_reset"
                onTokenChange={setResetCaptchaToken}
              />
              <Button
                type="submit"
                className="w-full h-11"
                disabled={
                  isLoading ||
                  !!resetCooldownUntil ||
                  isTurnstileSubmissionBlocked(resetCaptchaToken)
                }
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {tAuth('reset_sending')}
                  </>
                ) : resetCooldownUntil ? (
                  tAuth('reset_cooldown', { seconds: resetCooldownRemaining })
                ) : (
                  tAuth('reset_button')
                )}
              </Button>
            </form>
          </div>

          <Button
            variant="ghost"
            className="w-full mt-4 text-muted-foreground"
            onClick={closeResetForm}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {tAuth('back_to_login')}
          </Button>
        </div>
      </div>
    )
  }

  const showBankIdChip = method === 'email' && bankIdEnabled
  const showEmailChip = method === 'bankid' && passwordLoginEnabled
  const samlAvailable = samlEnabled && canUseSaml
  const chipCount = (showBankIdChip ? 1 : 0) + (showEmailChip ? 1 : 0) + providers.length + (samlAvailable ? 1 : 0)

  const hasPrimaryMethod =
    (method === 'bankid' && bankIdEnabled) ||
    (method === 'email' && passwordLoginEnabled)
  const hasSecondaryMethods = chipCount > 0

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <header className="text-center mb-8">
          <h1 className="sr-only">{tAuth('login_title')}</h1>
          <BrandWordmark size="hero" />
        </header>

        <div className="rounded-xl border border-border bg-background p-6">
          {timeoutReason && (
            <div role="alert" className="mb-4">
              <AttnLine>
                {timeoutReason === 'idle' ? tAuth('session_idle') : tAuth('session_absolute')}
              </AttnLine>
            </div>
          )}
          {callbackError === 'auth_error' && (
            <div className="mb-4">
              {callbackFlow === 'oauth' ? (
                <AuthFormError
                  message={`${tAuth('callback_error_title_oauth')}. ${tAuth('callback_error_body_oauth')}`}
                />
              ) : callbackFlow === 'recovery' ? (
                <AuthFormError
                  message={`${tAuth('callback_error_title')}. ${tAuth('callback_error_body')}`}
                  action={
                    <button
                      type="button"
                      onClick={openResetForm}
                      className="font-medium underline underline-offset-2"
                    >
                      {tAuth('request_new_reset_link')}
                    </button>
                  }
                />
              ) : (
                <AuthFormError
                  message={`${tAuth('callback_error_title_signup')}. ${tAuth('callback_error_body_signup')}`}
                />
              )}
            </div>
          )}
          {panelError && (
            <div className="mb-4">
              <AuthFormError message={panelError.message} />
            </div>
          )}
          {bankIdNoAccount && (
            <div className="mb-4 text-[13px] leading-5">
              <p className="font-medium">
                {tAuth('bankid_no_account_greeting', { name: bankIdNoAccount.givenName ?? '' })}
              </p>
              <p className="mt-1 text-muted-foreground">{tAuth('bankid_no_account_body')}</p>
        {passwordLoginEnabled && registrationEnabled && (
                <p className="mt-1">
                  <Link
                    href={registerHref}
                    className="text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                  >
                    {tAuth('bankid_no_account_create')}
                  </Link>
                </p>
              )}
            </div>
          )}
          {bankIdUnavailable && (
            <div className="mb-4 text-[13px] leading-5">
              <p className="font-medium">{tAuth('bankid_unavailable_title')}</p>
              <p className="mt-1 text-muted-foreground">{tAuth('bankid_unavailable_body')}</p>
            </div>
          )}

          <div key={method} className="animate-fade-in">
            {method === 'bankid' && bankIdEnabled ? (
              <BankIdAuth mode="login" hero onComplete={handleBankIdComplete} />
            ) : method === 'email' && passwordLoginEnabled ? (
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{tAuth('email_label')}</Label>
                  <Input
                    ref={emailInputRef}
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder={tAuth('email_placeholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    aria-invalid={formError?.kind === 'invalid_credentials' || undefined}
                    className="h-11"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">{tAuth('password_label')}</Label>
                    <button
                      type="button"
                      onClick={openResetForm}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                    >
                      {tAuth('forgot_password')}
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      ref={passwordInputRef}
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder={tAuth('password_placeholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      aria-invalid={formError?.kind === 'invalid_credentials' || undefined}
                      className="h-11 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={showPassword ? tAuth('hide_password') : tAuth('show_password')}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  {formLevelError && (
                    <p
                      role="alert"
                      className="animate-fade-in flex items-start gap-2 pt-1 text-[13px] leading-5 text-destructive"
                    >
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        {formLevelError.message}
                        {formLevelError.kind === 'invalid_credentials' && failedAttempts >= 2 && (
                          <>
                            {' '}
                            <button
                              type="button"
                              onClick={openResetForm}
                              className="font-medium underline underline-offset-2"
                            >
                              {tAuth('login_error_reset_link')}
                            </button>
                          </>
                        )}
                      </span>
                    </p>
                  )}
                </div>
                <TurnstileChallenge
                  ref={passwordTurnstileRef}
                  action="accounted_login"
                  onTokenChange={setPasswordCaptchaToken}
                />
                <Button
                  type="submit"
                  className="w-full h-11"
                  disabled={isLoading || isTurnstileSubmissionBlocked(passwordCaptchaToken)}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {tAuth('logging_in')}
                    </>
                  ) : (
                    tAuth('login_button')
                  )}
                </Button>
              </form>
            ) : (
              providers.length > 0 ? (
                <div className="space-y-3">
                  {providers.map((provider) => (
                    <OAuthButton
                      key={provider.id}
                      provider={provider}
                      next={nextPath}
                      onError={(message) => setFormError({ kind: 'oauth', message })}
                    />
                  ))}
                  {samlAvailable && !hasPrimaryMethod && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full h-11 gap-2"
                      onClick={handleSamlLogin}
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <KeyRound className="mr-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      )}
                      {tAuth('continue_with_provider', { provider: 'SAML' })}
                    </Button>
                  )}
                </div>
              ) : samlAvailable ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 gap-2"
                  onClick={handleSamlLogin}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="mr-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  {tAuth('continue_with_provider', { provider: 'SAML' })}
                </Button>
              ) : (
                <p className="text-center text-sm text-muted-foreground">
                  {tAuth('no_login_methods')}
                </p>
              )
            )}
          </div>

          {hasPrimaryMethod && hasSecondaryMethods && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-background px-3 text-xs text-muted-foreground">
                    {tAuth('or_divider')}
                  </span>
                </div>
              </div>
              <div className={chipCount === 2 ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
                {showBankIdChip && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full gap-2"
                    onClick={() => switchMethod('bankid')}
                  >
                    <Image
                      src="/logos/bankid-seeklogo.svg"
                      alt=""
                      width={18}
                      height={18}
                      className="dark:invert"
                    />
                    BankID
                  </Button>
                )}
                {providers.map((provider) => (
                  <OAuthButton
                    compact
                    key={provider.id}
                    provider={provider}
                    next={nextPath}
                    onError={(message) => setFormError({ kind: 'oauth', message })}
                  />
                ))}
                {showEmailChip && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full gap-2"
                    onClick={() => switchMethod('email')}
                  >
                    <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {tAuth('method_email_chip')}
                  </Button>
                )}
                {samlAvailable && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 w-full gap-2"
                    onClick={handleSamlLogin}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    {tAuth('continue_with_provider', { provider: 'SAML' })}
                  </Button>
                )}
              </div>
            </>
          )}
        </div>

        {passwordLoginEnabled && registrationEnabled && (
          <p className="mt-6 text-center text-[13px] text-muted-foreground">
            {tAuth('login_new_here')}{' '}
            <Link
              href={registerHref}
              className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity"
            >
              {tAuth('no_account')}
            </Link>
          </p>
        )}

        <p className="mt-3 text-center text-xs text-muted-foreground/80 leading-relaxed">
          {tAuth('terms_prefix')}{' '}
          {/* The platform's terms live on the marketing site; the privacy
              policy is the in-app /privacy page (host-relative, so it works
              on branded byrå domains too). New tab: don't lose login state. */}
          <a
            href="https://accounted.se/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {tAuth('terms_link')}
          </a>{' '}
          {tAuth('terms_and')}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {tAuth('privacy_link')}
          </a>
          .
        </p>

        {/* AGPL section 13 source offer (WL-06): renders on both default and
            branded hosts; never gate this on a brand. */}
        <SourceCodeFooter className="mt-4" />
      </div>
    </div>
  )
}
