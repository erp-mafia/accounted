'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, KeyRound } from 'lucide-react'
import { userHasPassword } from '@/lib/auth/has-password'
import { safeReturnTo } from '@/lib/auth/safe-return-to'

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordContent />
    </Suspense>
  )
}

function SetPasswordContent() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/settings/account')

  // Users who already have a password don't belong here: bounce them away.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (cancelled) return
      if (!user) {
        router.replace('/login')
        return
      }
      if (userHasPassword(user)) {
        router.replace(returnTo)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSetPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    const strong =
      password.length >= 8 &&
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^a-zA-Z0-9]/.test(password)

    if (!strong) {
      toast({
        title: 'Lösenordet är för svagt',
        description:
          'Lösenordet måste vara minst 8 tecken och innehålla versaler, gemener, siffror och specialtecken.',
        variant: 'destructive',
      })
      setIsLoading(false)
      return
    }

    if (password !== confirmPassword) {
      toast({
        title: 'Lösenorden matchar inte',
        description: 'Kontrollera att du skrev samma lösenord i båda fälten.',
        variant: 'destructive',
      })
      setIsLoading(false)
      return
    }

    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast({
          title: 'Kunde inte spara lösenord',
          description: body.error || 'Försök igen senare.',
          variant: 'destructive',
        })
        return
      }

      toast({
        title: 'Lösenord sparat',
        description: 'Du kan nu aktivera tvåfaktorsautentisering.',
      })

      router.push(returnTo)
      router.refresh()
    } catch {
      toast({
        title: 'Något gick fel',
        description: 'Försök igen senare.',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-lg bg-secondary flex items-center justify-center">
              <KeyRound className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="font-display text-3xl tracking-tight">
            Sätt ett lösenord
          </h1>
          <p className="text-muted-foreground text-sm mt-2">
            Du loggade in med BankID. För att aktivera tvåfaktorsautentisering
            eller logga in med e-post behöver du först sätta ett lösenord.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <form onSubmit={handleSetPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Lösenord</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder="Minst 8 tecken, Aa1!"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                disabled={isLoading}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_password">Bekräfta lösenord</Label>
              <Input
                id="confirm_password"
                type="password"
                autoComplete="new-password"
                placeholder="Upprepa lösenordet"
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
                  Sparar...
                </>
              ) : (
                'Spara lösenord'
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
