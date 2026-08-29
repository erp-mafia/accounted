'use client'

import { useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Check, Loader2, Mail, ArrowLeft, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import type { BankIdResult } from '@/components/auth/BankIdAuth'
import { useBranding } from '@/lib/branding/brand-context'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
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
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import {
  captchaTokenOptions,
  isTurnstileSubmissionBlocked,
} from '@/lib/auth/turnstile'
import { persistLoginMethodHint, type LoginMethod } from '@/lib/auth/login-method'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { cn } from '@/lib/utils'
import type { GoTrueAuthSettings } from '@/lib/auth/gotrue-providers'

const BankIdAuth = dynamic(
  () => import('@/components/auth/BankIdAuth').then((module) => module.BankIdAuth),
  { ssr: false },
)

export function RegisterClient({ authSettings }: { authSettings: GoTrueAuthSettings }) {
  const { providers, passwordLoginEnabled, registrationEnabled } = authSettings
  // `invite` and `next` are the only query parameters this page reads.
  //
  // `next` is the post-signup destination /login forwards when a visitor with
  // no account arrives from the MCP OAuth consent page
  // (/login?next=/api/mcp-oauth/authorize?…, issue #1814). It goes through
  // safeReturnTo (lib/auth/safe-return-to.ts); a hand-rolled check on this
  // value is an open redirect. Without one ('/'), nothing changes: the
  // password path leaves through the confirmation mail and /auth/callback,
  // and the BankID path lands a brand-new account on /select-company. With
  // one, every path resumes it: BankID hard-navigates (the consent page is a
  // route handler returning raw HTML), while the confirmation link and Google
  // OAuth carry it to /auth/callback, which honours only the consent
  // destination. A new account has no membership to spend a deep link on, so
  // nothing else may ever be forwarded here.
  const searchParams = useSearchParams()
  const nextPath = safeReturnTo(searchParams.get('next'), '/')
  const loginHref = nextPath === '/' ? '/login' : `/login?next=${encodeURIComponent(nextPath)}`
  const inviteToken = searchParams.get('invite')

  // When password login is not available, self-service registration is not
  // possible. Redirect to login unless this is an invite-based signup.
  const router = useRouter()
  useEffect(() => {
    if ((!passwordLoginEnabled || !registrationEnabled) && !inviteToken) {
      router.replace('/login')
    }
  }, [inviteToken, router, passwordLoginEnabled, registrationEnabled])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isRegistered, setIsRegistered] = useState(false)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  // Invite-only brand domain (signup gate said no): the form is replaced by
  // an interstitial pointing at the canonical Accounted signup.
  const [inviteOnlyBlocked, setInviteOnlyBlocked] = useState(false)
  const [inviteEmail, setInviteEmail] = useState<string | null>(null)
  const [bankIdUser, setBankIdUser] = useState<{ givenName?: string; surname?: string } | null>(null)
  const [bankIdFlowId, setBankIdFlowId] = useState<string | null>(null)
  const [bankIdEmail, setBankIdEmail] = useState('')
  // Signup failures render inline next to the form (see AuthFormError), never
  // as a toast. Field-level problems attach to their field; everything else
  // goes to the form-level alert above the form.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind | 'bankid' | 'oauth'; message: string } | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const confirmInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const turnstileRef = useRef<TurnstileChallengeHandle>(null)
  const { toast } = useToast()
  const supabase = createClient()
  const bankIdEnabled = isBankIdEnabled()
  // Per-request brand merged over getBranding() defaults (WL-12): identical
  // values on default hosts, brand values on branded hosts.
  const branding = useBranding()
  const t = useTranslations('register')
  const tAuth = useTranslations('auth')
  const tInvite = useTranslations('invite')
  const errorLocale = useLocale() as ErrorLocale

  // Which method owns the panel (mirrors the login page): BankID is the
  // Swedish default for a fresh signup; the email form is one chip away.
  const [method, setMethod] = useState<LoginMethod>(bankIdEnabled ? 'bankid' : 'email')
  const prevMethodRef = useRef(method)

  // Switching to the email form should land the caret in the first field,
  // except when an invite pre-filled and locked it.
  useEffect(() => {
    if (prevMethodRef.current !== method) {
      prevMethodRef.current = method
      if (method === 'email' && !inviteEmail) emailInputRef.current?.focus()
    }
  }, [method, inviteEmail])

  const switchMethod = (next: LoginMethod) => {
    setFormError(null)
    setMethod(next)
  }

  const showBankIdChip = method === 'email' && bankIdEnabled
  const showEmailChip = method === 'bankid' && passwordLoginEnabled
  const chipCount = (showBankIdChip ? 1 : 0) + (showEmailChip ? 1 : 0) + providers.length

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

  // When arriving from an invite link, fetch the invite info to pre-fill
  // and lock the email field so the user registers with the correct address.
  // BOTH signup forms are pre-filled: the BankID form used to be left blank
  // and editable, so an invitee who signed up with BankID typed their private
  // address, POST /api/team/accept answered 403 on the email equality check,
  // and they landed on /select-company with no membership. The token now
  // survives that 403 (lib/auth/consume-invite-cookie.ts) so it is recoverable
  // rather than terminal, but the signup should not walk into it at all.
  useEffect(() => {
    const inviteToken = searchParams.get('invite')
    if (!inviteToken) return

    fetch(`/api/team/accept?token=${encodeURIComponent(inviteToken)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.data?.email) {
          setInviteEmail(data.data.email)
          setEmail(data.data.email)
          setBankIdEmail(data.data.email)
        }
      })
      .catch(() => {})
  }, [searchParams])

  const [bankIdUnavailable, setBankIdUnavailable] = useState(false)

  const handleBankIdComplete = (result: BankIdResult) => {
    if (result.error === 'service_unavailable') {
      setBankIdUnavailable(true)
      setMethod('email')
      return
    }

    if (result.error) {
      setFormError({ kind: 'bankid', message: t('bankid_failed_description') })
      return
    }
    // BankID verified: show the email form. The session itself stays in the
    // server's HttpOnly flow cookie, so there is nothing to hold on to here.
    setFormError(null)
    setBankIdUser({ givenName: result.givenName, surname: result.surname })
    setBankIdFlowId(result.flowId ?? null)
  }

  const handleBankIdSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('bankid_email') as string) || bankIdEmail

    if (!bankIdFlowId) {
      setFormError({ kind: 'bankid', message: t('bankid_failed_description') })
      return
    }

    setIsLoading(true)

    try {
      // Only the e-mail travels: the session and the fact that this is a
      // signup are both pinned in the server's flow cookie.
      const res = await fetch('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bankid-flow-id': bankIdFlowId,
        },
        body: JSON.stringify({ email: emailValue }),
      })

      const json = await res.json()

      if (!res.ok) {
        if (json.error === 'signup_not_allowed') {
          // Invite-only brand domain: same interstitial as the email path.
          setInviteOnlyBlocked(true)
          return
        }
        if (json.error === 'already_linked') {
          // email_exists kind: the alert renders a sign-in link, which is the
          // recovery path for both "BankID taken" and "email taken".
          setFormError({ kind: 'email_exists', message: t('bankid_already_linked_description') })
        } else if (json.error === 'account_exists') {
          // Inline with a sign-in link instead of yanking the user to /login
          // mid-read: they keep the context and choose when to leave.
          setFormError({ kind: 'email_exists', message: t('account_exists_description') })
        } else {
          setFormError({
            kind: 'unknown',
            message: json.message || json.error || t('register_failed_default'),
          })
        }
        return
      }

      // Exchange token hash for Supabase session
      const { error } = await supabase.auth.verifyOtp({
        token_hash: json.data.tokenHash,
        type: json.data.type as 'magiclink',
      })

      if (error) {
        console.error('[register] BankID verifyOtp failed', error.message)
        setFormError({
          kind: 'unknown',
          message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        })
        return
      }

      // Invited signup: accept the pending invite before routing to the
      // picker, same as the login page's BankID path. Without this, an
      // invitee who registers with BankID lands on /select-company with no
      // membership and gets funneled into creating a company instead of
      // joining the one they were invited to.
      persistLoginMethodHint('bankid')

      if (await acceptPendingInvite()) {
        window.location.href = '/'
        return
      }

      if (nextPath !== '/') {
        // Resume the MCP consent flow: the account exists and the consent
        // page accepts a user with no company yet.
        window.location.assign(nextPath)
        return
      }

      router.push('/select-company')
      router.refresh()
    } catch (error) {
      console.error('[register] BankID signup error', error instanceof Error ? error.message : String(error))
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      setIsLoading(false)
    }
  }

  // The live checklist under the password field mirrors these rules; the
  // aggregate check gates submission.
  const passwordChecks = [
    { key: 'password_req_length', met: password.length >= 8 },
    { key: 'password_req_case', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { key: 'password_req_number', met: /[0-9]/.test(password) },
    { key: 'password_req_special', met: /[^a-zA-Z0-9]/.test(password) },
  ] as const

  function isStrongPassword(pw: string): boolean {
    return pw.length >= 8
      && /[a-z]/.test(pw)
      && /[A-Z]/.test(pw)
      && /[0-9]/.test(pw)
      && /[^a-zA-Z0-9]/.test(pw)
  }

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)
    setPasswordError(null)
    setConfirmError(null)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password
    const confirmValue = (formData.get('confirm_password') as string) || confirmPassword

    // Client-side checks run before isLoading so the inputs are still enabled
    // when focus moves to the offending field.
    if (!isStrongPassword(passwordValue)) {
      setPasswordError(t('password_error_requirements'))
      passwordInputRef.current?.focus()
      return
    }

    if (passwordValue !== confirmValue) {
      setConfirmError(t('password_mismatch_description'))
      confirmInputRef.current?.focus()
      confirmInputRef.current?.select()
      return
    }

    if (isTurnstileSubmissionBlocked(captchaToken)) {
      setFormError({ kind: 'unknown', message: tAuth('turnstile_required') })
      return
    }

    setIsLoading(true)

    try {
      // Server-side signup (POST /api/auth/signup): the route performs the
      // GoTrue signUp and enforces the invite-only brand-domain gate, which
      // a direct browser call to Supabase would bypass. It builds the
      // /auth/callback confirmation URL from the request host and carries
      // `next` along, so the mail flow is unchanged.
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailValue,
          password: passwordValue,
          captchaToken: captchaTokenOptions(captchaToken).captchaToken ?? null,
          next: nextPath !== '/' ? nextPath : null,
        }),
      })
      const json = await res.json().catch(() => ({}))

      if (!res.ok) {
        const error = {
          code: json?.error?.code,
          message: json?.error?.message ?? t('register_failed_default'),
          status: res.status,
        }
        if (error.code === 'signup_not_allowed') {
          // Invite-only brand domain: swap the form for the interstitial
          // that sends the visitor to the canonical Accounted signup.
          setInviteOnlyBlocked(true)
          return
        }
        if (error.code === 'brand_lookup_failed') {
          // Transient brand-lookup error (the gate failed safe rather than
          // guess). Ask the user to retry instead of implying they were
          // turned away. Localized here, not from the raw response envelope.
          setFormError({ kind: 'unknown', message: t('error_temporary') })
          return
        }
        // The route's validateBody rejection is a flat envelope with no
        // `code`; the client already gates password strength and presence
        // before this fetch, so a 400 without a code is an email Zod
        // rejected (e.g. user@localhost, which passes the browser's
        // type=email). Surface the specific field message, not the generic.
        if (!error.code && res.status === 400) {
          setFormError({ kind: 'email_invalid', message: t('error_email_invalid') })
          return
        }
        console.error('[register] signUp error', error.message)
        const kind = classifyAuthError(error)
        if (kind === 'weak_password') {
          // Server-side password policy rejection: same field, same message
          // as the client-side check.
          setPasswordError(t('password_error_requirements'))
        } else {
          const messageByKind: Partial<Record<AuthErrorKind, string>> = {
            email_exists: t('account_exists_description'),
            email_invalid: t('error_email_invalid'),
            rate_limited: t('error_rate_limited'),
            signup_disabled: t('error_signup_disabled'),
          }
          setFormError({
            kind,
            message:
              messageByKind[kind] ??
              getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          })
        }
        return
      }

      persistLoginMethodHint('email')

      // If auto-confirmed (local dev), process invite immediately and redirect
      if (json?.data?.status === 'session') {
        const cookieMatch = document.cookie.match(/gnubok-invite-token=([^;]+)/)
        const inviteToken = cookieMatch?.[1]

        if (inviteToken) {
          try {
            const res = await fetch('/api/team/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: inviteToken }),
            })

            if (res.ok) {
              document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
              window.location.href = '/'
              return
            }
          } catch (err) {
            console.error('[register] invite acceptance failed:', err instanceof Error ? err.message : String(err))
          }
        }

        // Auto-confirmed but no invite or invite failed: go to onboarding
        // (invite cookie is preserved so the onboarding fallback can retry),
        // or resume the MCP consent flow when that is where we came from.
        window.location.href = nextPath
        return
      }

      // Supabase obfuscates duplicate signups (to prevent user enumeration):
      // when the email already belongs to a confirmed account, no mail is
      // sent. The route surfaces that as 'duplicate' so we don't show a
      // misleading "check your email" screen.
      if (json?.data?.status === 'duplicate') {
        setDuplicateEmail(emailValue)
        return
      }

      setEmail(emailValue)
      setIsRegistered(true)
    } catch (error) {
      console.error('[register] unexpected exception', error instanceof Error ? error.message : String(error))
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      turnstileRef.current?.reset()
      setIsLoading(false)
    }
  }

  if (inviteOnlyBlocked) {
    // Deliberately no email in the outbound URL: the canonical register page
    // never reads one, and an address in a URL lands in browser history,
    // Referer headers and proxy logs. The visitor retypes it.
    const canonicalRegisterHref = `${branding.appUrl.replace(/\/+$/, '')}/register`

    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl tracking-tight">
              {t('invite_only_title', { appName: branding.appName })}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t('invite_only_body', { appName: branding.appName })}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('invite_only_hint')}
            </p>
          </div>

          <div className="space-y-2">
            <Button className="w-full" asChild>
              <a href={canonicalRegisterHref}>
                {t('invite_only_cta')}
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setInviteOnlyBlocked(false)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (duplicateEmail) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl tracking-tight">{t('duplicate_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t('duplicate_body_prefix')}{' '}
              <span className="font-medium text-foreground">{duplicateEmail}</span>.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('duplicate_hint')}
            </p>
          </div>

          <div className="space-y-2">
            {/*
              Plain /login, no `email` parameter: app/(auth)/login/page.tsx
              reads only `error`, `flow` and `next`, so the address was
              travelling in the URL (browser history, Referer, every proxy
              access log) and arriving nowhere. The address is already on
              screen above, so nothing is lost by dropping it.
            */}
            <Button className="w-full" asChild>
              <Link href={loginHref}>
                {t('sign_in')}
              </Link>
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setDuplicateEmail(null)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (isRegistered) {
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
            <h1 className="text-2xl tracking-tight">{t('confirm_email_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t.rich('confirm_email_body', {
                email,
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('confirm_email_hint')}
            </p>
          </div>

          <div className="space-y-2">
            {webmailHint && (
              <Button className="w-full" asChild>
                <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                  {t(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                    provider: webmailHint.name,
                  })}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
            <Button variant="ghost" className="w-full text-muted-foreground" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back_to_login')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <header className="text-center mb-8">
          <h1 className="sr-only">{t('create_account')}</h1>
          <BrandWordmark size="hero" />
        </header>

        <div className="rounded-xl border border-border bg-background p-6">
          {bankIdUnavailable && !bankIdUser && (
            <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
              {t('bankid_unavailable_body')}
            </p>
          )}

          {formError && (
            <div className="mb-4">
              <AuthFormError
                message={formError.message}
                action={
                  formError.kind === 'email_exists' ? (
                    <Link
                      href={loginHref}
                      className="font-medium underline underline-offset-2"
                    >
                      {t('sign_in')}
                    </Link>
                  ) : undefined
                }
              />
            </div>
          )}

          {bankIdUser ? (
            <form onSubmit={handleBankIdSignup} className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-sm font-medium">
                  {bankIdUser.givenName} {bankIdUser.surname}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('bankid_verified')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bankid_email">{t('email_label')}</Label>
                <Input
                  id="bankid_email"
                  name="bankid_email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('email_placeholder')}
                  value={bankIdEmail}
                  onChange={(e) => setBankIdEmail(e.target.value)}
                  required
                  disabled={isLoading || !!inviteEmail}
                  readOnly={!!inviteEmail}
                  className="h-11"
                />
                <p className="text-xs text-muted-foreground">
                  {inviteEmail ? t('invite_email_hint') : t('bankid_email_hint')}
                </p>
              </div>
              {/* Also disabled while Back's /cancel is in flight: submitting
                  then would race the cookie clear (recoverable, but pointless). */}
              <Button type="submit" className="w-full h-11" disabled={isLoading || isCancelling}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('create_account')
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                disabled={isLoading || isCancelling}
                onClick={async () => {
                  // AWAIT the cancel before remounting BankIdAuth. The flow
                  // cookie outlives this component and BankIdAuth probes for a
                  // live flow on mount, so clearing the form first would let it
                  // find the still-completed session. Its own isCancelling
                  // state, not isLoading: isLoading drives the submit button's
                  // "Skapar konto...", and pressing Back should not claim an
                  // account is being created.
                  setIsCancelling(true)
                  try {
                    const res = await fetch('/api/extensions/ext/tic/bankid/cancel', {
                      method: 'POST',
                      headers: bankIdFlowId
                        ? { 'x-bankid-flow-id': bankIdFlowId }
                        : undefined,
                    })
                    if (!res.ok) throw new Error(`cancel failed: ${res.status}`)
                    // Flow cleared server-side; the remounted BankIdAuth will
                    // probe, find nothing, and show the start button.
                    setBankIdUser(null)
                    setBankIdFlowId(null)
                  } catch {
                    // The flow is still live, so resetting the form would just
                    // bounce the user back here. Say so instead of looping.
                    setFormError({ kind: 'bankid', message: t('bankid_cancel_failed') })
                  } finally {
                    setIsCancelling(false)
                  }
                }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back')}
              </Button>
            </form>
          ) : (
          <div key={method} className="animate-fade-in">
          {method === 'bankid' && bankIdEnabled ? (
            <BankIdAuth mode="signup" hero onComplete={handleBankIdComplete} />
          ) : !passwordLoginEnabled ? (
            <p className="text-[13px] leading-5 text-muted-foreground">{t('password_signup_unavailable')}</p>
          ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('email_label')}</Label>
              <Input
                ref={emailInputRef}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={t('email_placeholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading || !!inviteEmail}
                readOnly={!!inviteEmail}
                className="h-11"
              />
              {inviteEmail && (
                <p className="text-xs text-muted-foreground">
                  {t('invite_email_hint')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('password_label')}</Label>
              <div className="relative">
                <Input
                  ref={passwordInputRef}
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder={t('password_placeholder')}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (passwordError && isStrongPassword(e.target.value)) {
                      setPasswordError(null)
                    }
                  }}
                  required
                  minLength={8}
                  disabled={isLoading}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby="password-requirements"
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
              <ul
                id="password-requirements"
                className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1"
              >
                {passwordChecks.map((check) => (
                  <li
                    key={check.key}
                    className={cn(
                      'flex items-center gap-2 text-xs transition-colors duration-150',
                      check.met ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className="flex h-3 w-3 items-center justify-center"
                    >
                      {check.met ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <span className="h-1 w-1 rounded-full bg-current opacity-60" />
                      )}
                    </span>
                    {t(check.key)}
                  </li>
                ))}
              </ul>
              {passwordError && (
                <p role="alert" className="text-xs text-destructive">
                  {passwordError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_password">{t('confirm_password_label')}</Label>
              <Input
                ref={confirmInputRef}
                id="confirm_password"
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                placeholder={t('confirm_password_placeholder')}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value)
                  if (confirmError && e.target.value === password) {
                    setConfirmError(null)
                  }
                }}
                required
                minLength={8}
                disabled={isLoading}
                aria-invalid={confirmError ? true : undefined}
                aria-describedby={confirmError ? 'confirm-password-error' : undefined}
                className="h-11"
              />
              {confirmError && (
                <p
                  id="confirm-password-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {confirmError}
                </p>
              )}
            </div>
            <TurnstileChallenge
              ref={turnstileRef}
              action="accounted_signup"
              onTokenChange={setCaptchaToken}
            />
            <Button
              type="submit"
              className="w-full h-11"
              disabled={isLoading || isTurnstileSubmissionBlocked(captchaToken)}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('create_account')
              )}
            </Button>
          </form>
          )}
          </div>
          )}

          {!bankIdUser && chipCount > 0 && (
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
                    key={provider.id}
                    provider={provider}
                    compact
                    onError={(message) => setFormError({ kind: 'oauth', message })}
                    next={nextPath}
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
              </div>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          {t('already_have_account')}{' '}
          <Link
            href={loginHref}
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            {t('sign_in')}
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-muted-foreground/80 leading-relaxed">
          {t('terms_prefix')}{' '}
          {/* Same targets as the login page: platform terms on the marketing
              site, in-app /privacy (host-relative for branded domains). */}
          <a
            href="https://accounted.se/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {t('terms_link')}
          </a>{' '}
          {t('terms_and')}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {t('privacy_link')}
          </a>
          .
        </p>
      </div>
    </div>
  )
}
