'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { AttnLine } from '@/components/ui/attn-line'
import {
  ArrowTopRightOnSquareIcon,
  EnvelopeIcon,
  ExclamationCircleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
} from '@/components/icons'
import {
  STANDALONE_LINK_CLASS,
  StandaloneHeading,
  StandaloneOr,
  StandalonePage,
  StandaloneBelowLine,
  StandaloneStack,
} from '@/components/standalone/StandalonePage'
import { SourceCodeFooter } from '@/components/branding/SourceCodeFooter'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import { useBranding } from '@/lib/branding/brand-context'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { resolvePostLoginDestination } from '@/lib/company/post-login-landing'
import {
  consumeInviteCookie,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'
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
import {
  LOGIN_METHOD_PARAM,
  loginMethodFromParam,
  persistLoginMethodHint,
  resolveInitialLoginMethod,
  type LoginMethod,
} from '@/lib/auth/login-method'
import { takeLoginEmailHandoff } from '@/lib/auth/login-email-handoff'
import {
  SESSION_ENDED_REASON,
  SIGN_OUT_EVERYWHERE_UNCONFIRMED_REASON,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'
import {
  signInWithPassword,
  startSsoSignIn,
  verifyOtp,
} from '@/lib/auth/session-client'
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
  // The proxy found a session in the browser that had ended (signed out on
  // another device, removed, its refresh token refused).
  const sessionEnded = reasonParam === SESSION_ENDED_REASON
  // "Logga ut från alla enheter" that the auth server did not confirm.
  const everywhereUnconfirmed = reasonParam === SIGN_OUT_EVERYWHERE_UNCONFIRMED_REASON
  // The panel a link asked for: the timeout redirect, or a page that knows
  // which method will work (the signup page's "Logga in" for an address that
  // already has an account opens the e-mail form).
  const requestedMethod = loginMethodFromParam(searchParams.get(LOGIN_METHOD_PARAM))
  // Post-login destination, set e.g. by the MCP OAuth authorize endpoint
  // (/login?next=/api/mcp-oauth/authorize?...). Sanitized to a same-origin
  // relative path; '/' means no explicit destination.
  const nextPath = safeReturnTo(searchParams.get('next'), '/')
  // A visitor who arrives here from the MCP consent page and has no account
  // yet must be able to sign up without losing that destination (issue
  // #1814). The register page re-sanitises it through safeReturnTo.
  const registerHref = nextPath === '/' ? '/register' : `/register?next=${encodeURIComponent(nextPath)}`
  const bankIdEnabled = isBankIdEnabled()
  // Per-request brand merged over getBranding() defaults (WL-12): identical
  // values on default hosts, brand values on branded hosts.
  const branding = useBranding()
  const tAuth = useTranslations('auth')
  const tInvite = useTranslations('invite')
  const errorLocale = useLocale() as ErrorLocale

  // Which method owns the panel: a session-timeout re-login follows the
  // method that timed out; otherwise a requested method, then the cookie
  // hint; a fresh visitor starts on BankID (the Swedish default) when it is
  // enabled. Only the first panel: each method's sign-in is unchanged.
  const [method, setMethod] = useState<LoginMethod>(() =>
    resolveInitialLoginMethod({
      bankIdEnabled,
      passwordLoginEnabled,
      timedOut: timeoutReason !== null,
      requested: requestedMethod,
      remembered: initialMethod,
    }),
  )
  const prevMethodRef = useRef(method)

  // An address the signup page left for this form (it already has an
  // account): filled in, with the caret in the password field. A prefill
  // only, never submitted. Read after mount because it lives in the tab's
  // sessionStorage, which the server render cannot see.
  useEffect(() => {
    const handedOff = takeLoginEmailHandoff()
    if (!handedOff) return
    setEmail((current) => current || handedOff)
    passwordInputRef.current?.focus()
  }, [])

  // An ended session is a sign-out the user did not make here: the previous
  // identity goes, as after a timeout, so a shared device starts clean.
  useEffect(() => {
    if (timeoutReason || sessionEnded) resetAnalyticsIdentity()
  }, [timeoutReason, sessionEnded])

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
      // The server starts the flow (its PKCE verifier is an HttpOnly cookie)
      // and resolves the provider from NEXT_PUBLIC_SSO_PROVIDER_ID or
      // NEXT_PUBLIC_SSO_DOMAIN; the callback on this origin finishes it.
      const { url, error } = await startSsoSignIn(nextPath)
      if (error?.code === 'sso_not_configured') {
        setFormError({ kind: 'oauth', message: tAuth('saml_no_domain') })
        return
      }
      if (error || !url) {
        setFormError({ kind: 'oauth', message: getErrorMessage(error, { context: 'auth', locale: errorLocale }) })
        return
      }
      window.location.assign(url)
      return
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

    if (result.error === 'email_unconfirmed') {
      // The BankID identity exists but its e-mail was never confirmed: the
      // server re-sent the confirmation mail and explains what to do.
      setFormError({ kind: 'bankid', message: result.message ?? tAuth('bankid_email_unconfirmed') })
      return
    }
    if (result.error) {
      setFormError({ kind: 'bankid', message: tAuth('login_failed_bankid') })
      return
    }

    if (result.tokenHash && result.type) {
      try {
        // The server exchanges the one-time link and sets the HttpOnly
        // session cookie (it also records the BankID sign-in method).
        const { error } = await verifyOtp({
          token_hash: result.tokenHash,
          type: 'magiclink',
        })

        if (error) {
          console.error('[login] BankID verifyOtp failed', error.code ?? error.status)
          setFormError({ kind: 'bankid', message: tAuth('login_failed_bankid') })
          return
        }

        persistLoginMethodHint('bankid')

        // Check for pending invite token
        if (await acceptPendingInvite()) {
          window.location.href = '/'
          return
        }

        if (nextPath !== '/') {
          // An explicit destination (e.g. the MCP OAuth consent page, raw
          // HTML from a route handler) outranks the default landing.
          window.location.assign(nextPath)
          return
        }

        // The same landing as every other sign-in (crm#1034): byrå staff on
        // their byrå's home domain land in the cockpit (WL-14), everyone
        // else on '/', which opens the active company. A user without a
        // company is sent on by the middleware, to the BankID picker when
        // this login stored engagements. Engagements not yet in Accounted
        // wait under "Lägg till företag": as a stop on the way in, a company
        // the user chose not to add came back at every sign-in.
        router.push(await resolvePostLoginDestination())
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
      const { error, mfaRequired } = await signInWithPassword({
        email: emailValue,
        password: passwordValue,
        captchaToken: captchaTokenOptions(passwordCaptchaToken).captchaToken ?? null,
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

      persistLoginMethodHint('email')

      // The server answers whether the new session still owes an MFA step-up
      // (verified factor, AAL1 session), from GoTrue's own reply.
      if (mfaRequired) {
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
      // Server-side reset (POST /api/auth/password-reset): the route resolves
      // the recovery callback against the brands table from the request
      // host, so the browser carries no domain list and a new brand needs no
      // redeploy. GoTrue call, captcha and rate limits are unchanged.
      const res = await fetch('/api/auth/password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailValue,
          captchaToken: captchaTokenOptions(resetCaptchaToken).captchaToken ?? null,
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        const error = {
          code: json?.error?.code,
          message:
            (errorLocale === 'en' ? json?.error?.message_en : json?.error?.message) ??
            json?.error?.message,
          status: res.status,
        }
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
      <StandalonePage>
        <StandaloneHeading
          title={tAuth('email_sent_title')}
          sub={
            showResetPassword
              ? tAuth.rich('email_sent_body_reset', {
                  email,
                  strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                })
              : tAuth.rich('email_sent_body_login', {
                  email,
                  strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
                })
          }
        />
        <StandaloneStack>
          <p className="text-sm text-foreground">
            {showResetPassword ? tAuth('email_sent_hint_reset') : tAuth('email_sent_hint_login')}
          </p>
          {webmailHint && (
            <Button variant="outline" size="lg" className="w-full" asChild>
              <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                {tAuth(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                  provider: webmailHint.name,
                })}
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={() => {
              setIsEmailSent(false)
              setShowResetPassword(false)
            }}
          >
            {tAuth('back_to_login')}
          </Button>
        </StandaloneStack>
      </StandalonePage>
    )
  }

  // Reset password form
  if (showResetPassword) {
    return (
      <StandalonePage>
        <StandaloneHeading title={tAuth('reset_title')} sub={tAuth('reset_subtitle')} />
        <StandaloneStack>
            <form onSubmit={handleResetPassword} className="flex flex-col gap-3">
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
                size="lg"
                className="w-full"
                loading={isLoading}
                disabled={
                  !!resetCooldownUntil ||
                  isTurnstileSubmissionBlocked(resetCaptchaToken)
                }
              >
                {isLoading ? (
                  tAuth('reset_sending')
                ) : resetCooldownUntil ? (
                  tAuth('reset_cooldown', { seconds: resetCooldownRemaining })
                ) : (
                  tAuth('reset_button')
                )}
              </Button>
            </form>
          <Button variant="ghost" size="lg" className="w-full" onClick={closeResetForm}>
            {tAuth('back_to_login')}
          </Button>
        </StandaloneStack>
      </StandalonePage>
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
    <StandalonePage
      hero
      below={
        <>
        {passwordLoginEnabled && registrationEnabled && (
          <StandaloneBelowLine>
            {tAuth('login_new_here')}{' '}
            <Link href={registerHref} className={STANDALONE_LINK_CLASS}>
              {tAuth('no_account')}
            </Link>
          </StandaloneBelowLine>
        )}

        <StandaloneBelowLine>
          {tAuth('terms_prefix')}{' '}
          {/* The in-app legal pages (host-relative, so they work on branded
              byrå domains too). New tab: don't lose login state. */}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className={STANDALONE_LINK_CLASS}>
            {tAuth('terms_link')}
          </a>{' '}
          {tAuth('terms_and')}{' '}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className={STANDALONE_LINK_CLASS}>
            {tAuth('privacy_link')}
          </a>
          .
        </StandaloneBelowLine>
          <SourceCodeFooter />
        </>
      }
    >
          <StandaloneHeading title={tAuth('login_title')} hidden />
          {timeoutReason && (
            <div role="alert" className="mb-4">
              <AttnLine>
                {timeoutReason === 'idle' ? tAuth('session_idle') : tAuth('session_absolute')}
              </AttnLine>
            </div>
          )}
          {sessionEnded && (
            <div role="alert" className="mb-4">
              <AttnLine>{tAuth('session_ended')}</AttnLine>
            </div>
          )}
          {everywhereUnconfirmed && (
            <div role="alert" className="mb-4">
              <AttnLine>{tAuth('sign_out_everywhere_unconfirmed')}</AttnLine>
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
              <form onSubmit={handlePasswordLogin} className="flex flex-col gap-3">
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
                  <Label htmlFor="password">{tAuth('password_label')}</Label>
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
                        <EyeSlashIcon className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <EyeIcon className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  {formLevelError && (
                    <div
                      role="alert"
                      className="animate-fade-in flex items-start gap-2 pt-1 text-[13px] leading-5 text-destructive"
                    >
                      <ExclamationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
                    </div>
                  )}
                  {/* The way forward sits under the field and its error, in
                      the same place whether or not the sign-in failed. */}
                  <p className="text-xs">
                    <button type="button" onClick={openResetForm} className={STANDALONE_LINK_CLASS}>
                      {tAuth('forgot_password')}
                    </button>
                  </p>
                </div>
                <TurnstileChallenge
                  ref={passwordTurnstileRef}
                  action="accounted_login"
                  onTokenChange={setPasswordCaptchaToken}
                />
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  loading={isLoading}
                  disabled={isTurnstileSubmissionBlocked(passwordCaptchaToken)}
                >
                  {isLoading ? tAuth('logging_in') : tAuth('login_button')}
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
                      size="lg"
                      className="w-full"
                      onClick={handleSamlLogin}
                      loading={isLoading}
                    >
                      {!isLoading && (
                        <KeyIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      )}
                      {tAuth('continue_with_provider', { provider: 'SAML' })}
                    </Button>
                  )}
                </div>
              ) : samlAvailable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full"
                  onClick={handleSamlLogin}
                  loading={isLoading}
                >
                  {!isLoading && (
                    <KeyIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
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
              <div className="my-3">
                <StandaloneOr>{tAuth('or_divider')}</StandaloneOr>
              </div>
              <div className={chipCount === 2 ? 'grid grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
                {showBankIdChip && (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full gap-2"
                    onClick={() => switchMethod('bankid')}
                  >
                    <Image
                      src="/logos/bankid-seeklogo.svg"
                      alt=""
                      width={18}
                      height={18}
                      className="dark:invert"
                    />
                    {chipCount === 2 ? 'BankID' : tAuth('continue_with_provider', { provider: 'BankID' })}
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
                    size="lg"
                    className="w-full gap-2"
                    onClick={() => switchMethod('email')}
                  >
                    <EnvelopeIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {tAuth('method_email_chip')}
                  </Button>
                )}
                {samlAvailable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full"
                    onClick={handleSamlLogin}
                    loading={isLoading}
                  >
                    {!isLoading && (
                      <KeyIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    {tAuth('continue_with_provider', { provider: 'SAML' })}
                  </Button>
                )}
              </div>
            </>
          )}

    </StandalonePage>
  )
}
