'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, KeyRound } from 'lucide-react'
import { INVITE_PROBLEM_MESSAGE_KEYS } from '@/lib/auth/consume-invite-cookie'
import { handoffPendingInvite } from './invite-handoff'

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
  const tInvite = useTranslations('invite')
  const searchParams = useSearchParams()
  const tokenHash = searchParams.get('token_hash')
  const [mode, setMode] = useState<Mode>('loading')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return
      if (session) setMode('set-password')
      else if (tokenHash) setMode('confirm-link')
      else setMode('enter-code')
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verifyFailed = (description: string) => {
    toast({
      title: t('verify_failed_title'),
      description,
      variant: 'destructive',
    })
  }

  const handleConfirmLink = async () => {
    if (!tokenHash) return
    setIsLoading(true)
    const { error } = await supabase.auth.verifyOtp({
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
    const { error } = await supabase.auth.verifyOtp({
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

    const strong = password.length >= 8
      && /[a-z]/.test(password)
      && /[A-Z]/.test(password)
      && /[0-9]/.test(password)
      && /[^a-zA-Z0-9]/.test(password)

    if (!strong) {
      toast({
        title: t('weak_title'),
        description: t('weak_description'),
        variant: 'destructive',
      })
      setIsLoading(false)
      return
    }

    if (password !== confirmPassword) {
      toast({
        title: t('mismatch_title'),
        description: t('mismatch_description'),
        variant: 'destructive',
      })
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
        toast({
          title: t('save_failed_title'),
          description: body.error || t('save_failed_description'),
          variant: 'destructive',
        })
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
      const inviteDestination = await handoffPendingInvite({
        getUser: async () => (await supabase.auth.getUser()).data.user,
        getAssuranceLevel: async () =>
          (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data,
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
      toast({
        title: t('save_failed_title'),
        description: t('save_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const subtitle =
    mode === 'confirm-link'
      ? t('confirm_subtitle')
      : mode === 'enter-code'
        ? t('code_subtitle')
        : t('subtitle')

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <KeyRound className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground text-sm mt-2">{subtitle}</p>
        </div>

        <div className="rounded-lg border bg-card p-6">
          {mode === 'loading' && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {mode === 'confirm-link' && (
            <div className="space-y-5">
              <Button
                type="button"
                className="w-full h-11"
                onClick={handleConfirmLink}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('confirm_verifying')}
                  </>
                ) : (
                  t('confirm_button')
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {t('confirm_hint')}
              </p>
            </div>
          )}

          {mode === 'enter-code' && (
            <form onSubmit={handleVerifyCode} className="space-y-5">
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
              <Button type="submit" className="w-full h-11" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('code_verifying')}
                  </>
                ) : (
                  t('code_button')
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {t('code_hint')}
              </p>
            </form>
          )}

          {mode === 'set-password' && (
            <form onSubmit={handleResetPassword} className="space-y-5">
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
              <Button type="submit" className="w-full h-11" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('submitting')}
                  </>
                ) : (
                  t('submit')
                )}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  )
}
