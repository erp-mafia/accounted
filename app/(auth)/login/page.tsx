'use client'

import { Suspense, useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Mail, ArrowLeft, KeyRound, ExternalLink } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid'
import { getBranding } from '@/lib/branding/service'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import {
  consumeInviteCookie,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import {
  isSessionAuthMethod,
  setSessionAuthMethodHint,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'

const branding = getBranding()
import type { BankIdResult } from '@/components/auth/BankIdAuth'

const BankIdAuth = dynamic(
  () => import('@/components/auth/BankIdAuth').then((module) => module.BankIdAuth),
  { ssr: false },
)

// Wrapping in Suspense is required because useSearchParams() forces
// dynamic rendering in Next.js 16; static prerender bails out otherwise.
export default function LoginPage() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <LoginPageContent />
    </Suspense>
  )
}

function LoginPageContent() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isEmailSent, setIsEmailSent] = useState(false)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [showPasswordFallback, setShowPasswordFallback] = useState(false)
  const [resetCooldownUntil, setResetCooldownUntil] = useState<number | null>(null)
  const [resetCooldownRemaining, setResetCooldownRemaining] = useState(0)
  const [bankIdNoAccount, setBankIdNoAccount] = useState<{ givenName?: string; surname?: string } | null>(null)
  // Auth failures render inline next to the form (see AuthFormError), never
  // as a toast: `kind` drives field highlighting and the recovery action.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind | 'bankid'; message: string } | null>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
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
  const supabase = createClient()
  const bankIdEnabled = isBankIdEnabled()
  const tAuth = useTranslations('auth')
  const tCommon = useTranslations('common')
  const tInvite = useTranslations('invite')
  const errorLocale = useLocale() as ErrorLocale

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

  const openResetForm = () => {
    setFormError(null)
    setShowResetPassword(true)
  }

  const closeResetForm = () => {
    setFormError(null)
    setShowResetPassword(false)
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

  const [bankIdUnavailable, setBankIdUnavailable] = useState(false)

  const handleBankIdComplete = async (result: BankIdResult) => {
    if (result.error === 'no_account') {
      setBankIdNoAccount({ givenName: result.givenName, surname: result.surname })
      return
    }

    if (result.error === 'service_unavailable') {
      setBankIdUnavailable(true)
      setShowPasswordFallback(true)
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

        // Always land on the picker after BankID login so the user sees
        // fresh CompanyRoles fetched during this session's enrichment.
        router.push('/select-company')
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
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailValue,
        password: passwordValue,
      })

      if (error) {
        const kind = classifyAuthError(error)
        const messageByKind: Partial<Record<AuthErrorKind, string>> = {
          invalid_credentials: tAuth('login_invalid_credentials'),
          email_not_confirmed: tAuth('login_error_email_not_confirmed'),
          rate_limited: tAuth('login_error_rate_limited'),
          user_banned: tAuth('login_error_user_banned'),
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

      router.push('/')
      router.refresh()
    } catch (error) {
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailValue, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
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
      setIsLoading(false)
    }
  }

  const isBankIdReauth = timeoutReason !== null &&
    requestedMethod === 'bankid' &&
    bankIdEnabled
  const showPasswordLogin = !isBankIdReauth ||
    showPasswordFallback ||
    bankIdUnavailable ||
    bankIdNoAccount !== null

  // Email sent confirmation screen
  if (isEmailSent) {
    const webmailHint = detectWebmailHint(email, branding.authEmailFrom)

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{tAuth('email_sent_title')}</h1>
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

          <div className="rounded-lg border bg-card p-4">
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-10">
            <div className="flex justify-center mb-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
                <KeyRound className="h-7 w-7 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl font-medium tracking-tight">{tAuth('reset_title')}</h1>
            <p className="text-muted-foreground text-sm mt-2">
              {tAuth('reset_subtitle')}
            </p>
          </div>

          <div className="rounded-lg border bg-card p-6">
            <form onSubmit={handleResetPassword} className="space-y-5">
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
              <Button type="submit" className="w-full h-11" disabled={isLoading || !!resetCooldownUntil}>
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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <BrandWordmark size="hero" className="mb-2" />
          <p className="text-muted-foreground text-sm mt-3">
            {tAuth('login_subtitle')}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6">
          {timeoutReason && (
            <div
              className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
              role="alert"
            >
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                {timeoutReason === 'idle'
                  ? tAuth('session_idle')
                  : tAuth('session_absolute')}
              </p>
            </div>
          )}
          {callbackError === 'auth_error' && (
            <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              {callbackFlow === 'recovery' ? (
                <>
                  <p className="text-sm font-medium text-destructive">
                    {tAuth('callback_error_title')}
                  </p>
                  <p className="mt-1 text-sm text-destructive/90">
                    {tAuth('callback_error_body')}{' '}
                    <button
                      type="button"
                      onClick={openResetForm}
                      className="font-medium underline underline-offset-2"
                    >
                      {tAuth('request_new_reset_link')}
                    </button>
                    .
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-destructive">
                    {tAuth('callback_error_title_signup')}
                  </p>
                  <p className="mt-1 text-sm text-destructive/90">
                    {tAuth('callback_error_body_signup')}
                  </p>
                </>
              )}
            </div>
          )}
          {bankIdEnabled && (
            <>
              {bankIdNoAccount ? (
                <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    {tAuth('bankid_no_account_greeting', { name: bankIdNoAccount.givenName ?? '' })}
                  </p>
                  <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                    {tAuth('bankid_no_account_body')}
                  </p>
                  <p className="mt-2">
                    <Link
                      href="/register"
                      className="text-xs text-amber-600 underline underline-offset-2 hover:text-amber-800 dark:text-amber-400"
                    >
                      {tAuth('bankid_no_account_create')}
                    </Link>
                  </p>
                </div>
              ) : (
                <div className="mb-5">
                  <BankIdAuth mode="login" onComplete={handleBankIdComplete} />
                </div>
              )}
              {isBankIdReauth && !showPasswordLogin ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="mb-5 w-full text-muted-foreground"
                  onClick={() => setShowPasswordFallback(true)}
                >
                  {tAuth('use_password_instead')}
                </Button>
              ) : (
                <div className="relative mb-5">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{tAuth('or_email_divider')}</span>
                  </div>
                </div>
              )}
            </>
          )}
          {bankIdUnavailable && (
            <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                {tAuth('bankid_unavailable_title')}
              </p>
              <p className="mt-1 text-sm text-blue-700 dark:text-blue-300">
                {tAuth('bankid_unavailable_body')}
              </p>
            </div>
          )}
          {formError && (
            <div className="mb-5">
              <AuthFormError
                message={formError.message}
                action={
                  formError.kind === 'invalid_credentials' ? (
                    <button
                      type="button"
                      onClick={openResetForm}
                      className="font-medium underline underline-offset-2"
                    >
                      {tAuth('login_error_reset_link')}
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}
          {showPasswordLogin && (
            <>
          <form onSubmit={handlePasswordLogin} className="space-y-5">
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
              <Input
                ref={passwordInputRef}
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                placeholder={tAuth('password_placeholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                aria-invalid={formError?.kind === 'invalid_credentials' || undefined}
                className="h-11"
              />
            </div>
            <Button type="submit" className="w-full h-11" disabled={isLoading}>
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

          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">{tAuth('or_divider')}</span>
            </div>
          </div>

          <Button
            variant="outline"
            className="w-full"
            asChild
          >
            <Link href="/register">
              {tAuth('no_account')}
            </Link>
          </Button>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground leading-relaxed">
          {tAuth('terms_prefix')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {tAuth('terms_link')}
          </a>{' '}
          {tAuth('terms_and')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {tAuth('privacy_link')}
          </a>
          .
        </p>
      </div>
    </div>
  )
}
