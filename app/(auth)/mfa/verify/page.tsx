'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ShieldCheck, LogOut } from 'lucide-react'
import { SupportLink } from '@/components/ui/support-link'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { resolvePostLoginDestination } from '@/lib/company/post-login-landing'
import {
  consumeInviteCookie,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'

export default function MfaVerifyPage() {
  return (
    <Suspense>
      <MfaVerifyContent />
    </Suspense>
  )
}

function MfaVerifyContent() {
  const t = useTranslations('mfa')
  const tCommon = useTranslations('common')
  const tInvite = useTranslations('invite')
  const [code, setCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null)
  const [lockoutRemaining, setLockoutRemaining] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  // Step-up landing target. Set by callers that need AAL2 to do something
  // sensitive (set/change password, unenroll MFA, etc.): /api/account/password
  // and SecuritySettings redirect here when GoTrue rejects with "AAL2 session
  // is required". Falls back to the dashboard for direct visits.
  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/')

  useEffect(() => {
    async function loadFactor() {
      const { data } = await supabase.auth.mfa.listFactors()
      const verifiedFactor = data?.totp?.find(f => f.status === 'verified')
      if (verifiedFactor) {
        setFactorId(verifiedFactor.id)
      } else {
        router.push('/')
      }
    }
    loadFactor()
    inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!lockoutUntil) return
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000))
      setLockoutRemaining(remaining)
      if (remaining <= 0) setLockoutUntil(null)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [lockoutUntil])

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

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!factorId || code.length !== 6) return

    setIsLoading(true)

    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      })

      if (challengeError) {
        toast({
          title: t('verify_failed_title'),
          description: t('verify_challenge_failed_description'),
          variant: 'destructive',
        })
        setIsLoading(false)
        return
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      })

      if (verifyError) {
        const attempts = failedAttempts + 1
        setFailedAttempts(attempts)

        if (attempts >= 3) {
          const delays = [5_000, 15_000, 30_000]
          const delay = delays[Math.min(attempts - 3, delays.length - 1)]
          setLockoutUntil(Date.now() + delay)
        }

        toast({
          title: t('wrong_code_title'),
          description: t('wrong_code_description'),
          variant: 'destructive',
        })
        setCode('')
        inputRef.current?.focus()
        setIsLoading(false)
        return
      }

      if (await acceptPendingInvite()) {
        window.location.href = '/'
        return
      }

      if (returnTo.startsWith('/api/')) {
        // Route-handler destinations (e.g. the MCP OAuth consent page)
        // return raw HTML the client router cannot render: hard-navigate.
        window.location.assign(returnTo)
        return
      }

      // Hosted byrå staff hit MFA before any dashboard, so the cockpit
      // landing (WL-14) resolves here too: only when no explicit step-up
      // destination was requested. Everyone else keeps returnTo/'/' exactly
      // as before (the helper degrades to '/' on any failure). The session
      // is AAL2 at this point, so the /api MFA gate passes.
      router.push(returnTo === '/' ? await resolvePostLoginDestination() : returnTo)
      router.refresh()
    } catch {
      toast({
        title: t('verify_failed_title'),
        description: t('unexpected_error'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-xl bg-primary/8 flex items-center justify-center">
              <ShieldCheck className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl tracking-tight">{t('verify_title')}</h1>
          <p className="text-muted-foreground text-sm mt-2">
            {t('verify_subtitle_full')}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6">
          <form onSubmit={handleVerify} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="code">{t('verify_code_label')}</Label>
              <Input
                ref={inputRef}
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required
                disabled={isLoading}
                className="h-11 text-center text-lg tracking-[0.5em] font-mono"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11"
              disabled={isLoading || code.length !== 6 || !!lockoutUntil}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('verifying')}
                </>
              ) : lockoutUntil ? (
                t('wait_seconds', { seconds: lockoutRemaining })
              ) : (
                t('verify_button')
              )}
            </Button>
          </form>
        </div>

        <Button
          variant="ghost"
          className="w-full mt-4 text-muted-foreground"
          onClick={handleLogout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {tCommon('logout')}
        </Button>

        <p className="text-xs text-muted-foreground text-center mt-4">
          {t('lost_authenticator')}{' '}
          <SupportLink variant="muted" subject="MFA: cannot sign in" className="inline">
            {t('contact_support')}
          </SupportLink>
        </p>
      </div>
    </div>
  )
}
