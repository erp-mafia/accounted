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
  // sensitive (set/change password, unenroll MFA, etc.) — /api/account/password
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
          console.error('[mfa/verify] invite acceptance failed:', err)
        }
        document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
      }

      router.push(returnTo)
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
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <ShieldCheck className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-medium tracking-tight">{t('verify_title')}</h1>
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
          <SupportLink variant="muted" subject="MFA — cannot sign in" className="inline">
            {t('contact_support')}
          </SupportLink>
        </p>
      </div>
    </div>
  )
}
