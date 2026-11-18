'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { fetchSessionUser, signOutEverywhereAndLeave, verifyOtp } from '@/lib/auth/session-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { StandaloneHeading, StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'
import { Skeleton } from '@/components/ui/skeleton'
import { INVITE_PROBLEM_MESSAGE_KEYS } from '@/lib/auth/consume-invite-cookie'
import { handoffPendingInvite } from './invite-handoff'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { passwordSavedDespiteFailure } from '@/lib/auth/password-change-result'

/**
 * Three entry modes:
 *
 * - 'set-password': a recovery session already exists (legacy email links
 *   land via /auth/callback, or a token was just verified below).
 * - 'confirm-link': the email link points here with ?token_hash=. The
 *   token is verified ONLY on an explicit button click: corporate mail
 *   scanners (Microsoft Defender SafeLinks) render pages and follow
 *   links but do not click buttons, so the one-time token survives
 *   scanning. Never verify in an effect; that re-opens the burn.
 * - 'enter-code': no session, no token_hash. The email also carries a
 *   one-time code the user can type together with their email address.
 *   The code length follows the project's Email OTP Length setting
 *   (this project uses 8, gotrue allows 6-10), so the input must never
 *   cap at 6: a maxLength shorter than the real code silently truncates
 *   what the user types and every verify fails.
 */
type Mode = 'loading' | 'set-password' | 'confirm-link' | 'enter-code'

function ResetPasswordInner() {
  const t = useTranslations('reset_password')
  const errorLocale = useLocale() as ErrorLocale
  const tInvite = useTranslations('invite')
  const tCommon = useTranslations('common')
  const searchParams = useSearchParams()
  const tokenHash = searchParams.get('token_hash')
  const [mode, setMode] = useState<Mode>('loading')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // A failed step says so in the form, under the heading, never in a toast
  // that leaves the page looking untouched.
  const [formError, setFormError] = useState<string | null>(null)
  // The password IS saved, but the auth server did not confirm that the other
  // devices were signed out (POST /api/account/password answers that as an
  // error). The form is gone then: the same password sent again is refused
  // as unchanged. In its place is the way out the message names.
  const [savedUnconfirmed, setSavedUnconfirmed] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => {
    let cancelled = false
    // The session is server-held (HttpOnly cookie): ask the server whether
    // one exists instead of reading it in the browser.
    fetchSessionUser().then((user) => {
      if (cancelled) return
      if (user) setMode('set-password')
      else if (tokenHash) setMode('confirm-link')
      else setMode('enter-code')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verifyFailed = (description: string) => {
    setFormError(description)
  }

  const handleConfirmLink = async () => {
    if (!tokenHash) return
    setIsLoading(true)
    setFormError(null)
    const { error } = await verifyOtp({
      token_hash: tokenHash,
      type: 'recovery',
    })
    setIsLoading(false)
    if (error) {
      // Burned or expired link: fall back to typing the code (a fresh
      // request may be needed, the hint says so).
      setMode('enter-code')
      verifyFailed(t('link_invalid_description'))
      return
    }
    setMode('set-password')
  }

  const handleVerifyCode = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setFormError(null)
    const { error } = await verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'recovery',
    })
    setIsLoading(false)
    if (error) {
      verifyFailed(t('code_invalid_description'))
      return
    }
    setMode('set-password')
  }

  const handleResetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setFormError(null)

    const strong = password.length >= 8
      && /[a-z]/.test(password)
      && /[A-Z]/.test(password)
      && /[0-9]/.test(password)
      && /[^a-zA-Z0-9]/.test(password)

    if (!strong) {
      setFormError(t('weak_description'))
      setIsLoading(false)
      return
    }

    if (password !== confirmPassword) {
      setFormError(`${t('mismatch_title')}. ${t('mismatch_description')}`)
      setIsLoading(false)
      return
    }

    try {
      // Routed through the API so the has_password flag flips in lock-step
      // with the password update. This is the unlock path for BankID-only
      // users who enrolled MFA and got locked out: the recovery session
      // bypasses AAL2, the API flips has_password, and the lockout banner
      // disappears the next time they log in.
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setFormError(
          getErrorMessage(body, {
            locale: errorLocale,
            fallback: `${t('save_failed_title')}. ${t('save_failed_description')}`,
          }),
        )
        if (passwordSavedDespiteFailure(body)) setSavedUnconfirmed(true)
        return
      }

      toast({
        title: t('saved_title'),
        description: t('saved_description'),
      })

      // Only now, with the reset finished and the session proven by the 2xx
      // above (that route runs requireAuth()), pick up a pending invitation.
      // This is the recovery flow's copy of what login, register and
      // /mfa/verify already do, and it is the only chance an invitee who
      // already has a company of their own gets: the server-side retry on
      // /onboarding never sees them. See ./invite-handoff.ts.
      // One /api/auth/me read (only if an invite is pending) serves both:
      // the user's MFA flags and the session's assurance levels, which the
      // server reads from verified sources, never from the cookie.
      let sessionUserRead: ReturnType<typeof fetchSessionUser> | null = null
      const sessionUser = () => (sessionUserRead ??= fetchSessionUser())
      const inviteDestination = await handoffPendingInvite({
        getUser: sessionUser,
        getAssuranceLevel: async () => (await sessionUser())?.aal ?? null,
        reportProblem: (problem) => {
          const keys = INVITE_PROBLEM_MESSAGE_KEYS[problem]
          toast({
            title: tInvite(keys.title),
            description: tInvite(keys.body),
            variant: 'destructive',
          })
        },
      })

      if (inviteDestination) {
        // Hard navigation: either the membership and the active company just
        // changed server-side, or the destination re-runs acceptance on the
        // server. Both leave the client router's cached render stale.
        window.location.href = inviteDestination
        return
      }

      router.push('/')
      router.refresh()
    } catch {
      setFormError(`${t('save_failed_title')}. ${t('save_failed_description')}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSignOutEverywhere = async () => {
    setIsLoading(true)
    // Leaves for /login with a full page load; a pending invitation is picked
    // up there, after the sign-in with the new password.
    await signOutEverywhereAndLeave()
  }

  const subtitle =
    mode === 'confirm-link'
      ? t('confirm_subtitle')
      : mode === 'enter-code'
        ? t('code_subtitle')
        : t('subtitle')

  return (
    <StandalonePage>
        <StandaloneHeading title={t('title')} sub={subtitle} />
        <StandaloneStack>
          {formError && <AuthFormError message={formError} />}
          {mode === 'loading' && (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          )}

          {mode === 'confirm-link' && (
            <div className="flex flex-col gap-3">
              <Button
                type="button"
                size="lg" className="w-full"
                onClick={handleConfirmLink}
                loading={isLoading}
              >
                {isLoading ? (
                  t('confirm_verifying')
                ) : (
                  t('confirm_button')
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('confirm_hint')}
              </p>
            </div>
          )}

          {mode === 'enter-code' && (
            <form onSubmit={handleVerifyCode} className="flex flex-col gap-3">
              <div className="space-y-2">
                <Label htmlFor="email">{t('email_label')}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">{t('code_label')}</Label>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder={t('code_placeholder')}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                  minLength={6}
                  maxLength={10}
                  disabled={isLoading}
                  className="h-11 tracking-widest"
                />
              </div>
              <Button type="submit" size="lg" className="w-full" loading={isLoading}>
                {isLoading ? (
                  t('code_verifying')
                ) : (
                  t('code_button')
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('code_hint')}
              </p>
            </form>
          )}

          {mode === 'set-password' && savedUnconfirmed && (
            <Button
              type="button"
              size="lg" className="w-full"
              onClick={handleSignOutEverywhere}
              loading={isLoading}
            >
              {tCommon('logout_everywhere')}
            </Button>
          )}

          {mode === 'set-password' && !savedUnconfirmed && (
            <form onSubmit={handleResetPassword} className="flex flex-col gap-3">
              <div className="space-y-2">
                <Label htmlFor="password">{t('new_password_label')}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('new_password_placeholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isLoading}
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm_password">{t('confirm_password_label')}</Label>
                <Input
                  id="confirm_password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('confirm_password_placeholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isLoading}
                  className="h-11"
                />
              </div>
              <Button type="submit" size="lg" className="w-full" loading={isLoading}>
                {isLoading ? (
                  t('submitting')
                ) : (
                  t('submit')
                )}
              </Button>
            </form>
          )}
        </StandaloneStack>
    </StandalonePage>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  )
}
