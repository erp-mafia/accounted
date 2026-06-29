'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, KeyRound } from 'lucide-react'

export default function ResetPasswordPage() {
  const t = useTranslations('reset_password')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()
  const router = useRouter()

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
      // users who enrolled MFA and got locked out — the recovery session
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

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <KeyRound className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-medium tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground text-sm mt-2">
            {t('subtitle')}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6">
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
        </div>
      </div>
    </div>
  )
}
