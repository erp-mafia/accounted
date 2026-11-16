'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { fetchSessionUser } from '@/lib/auth/session-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { StandaloneHeading, StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'
import { userHasPassword } from '@/lib/auth/has-password'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { getErrorMessage } from '@/lib/errors/get-error-message'

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
  // A failed save says so in the form, not in a toast.
  const [formError, setFormError] = useState<string | null>(null)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/settings/account')

  // Users who already have a password don't belong here: bounce them away.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const user = await fetchSessionUser()
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
    setFormError(null)

    const strong =
      password.length >= 8 &&
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^a-zA-Z0-9]/.test(password)

    if (!strong) {
      setFormError(
        'Lösenordet måste vara minst 8 tecken och innehålla versaler, gemener, siffror och specialtecken.',
      )
      setIsLoading(false)
      return
    }

    if (password !== confirmPassword) {
      setFormError('Lösenorden matchar inte. Kontrollera att du skrev samma lösenord i båda fälten.')
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
        setFormError(getErrorMessage(body, { fallback: 'Kunde inte spara lösenord. Försök igen senare.' }))
        return
      }

      toast({
        title: 'Lösenord sparat',
        description: 'Du kan nu aktivera tvåfaktorsautentisering.',
      })

      router.push(returnTo)
      router.refresh()
    } catch {
      setFormError('Något gick fel. Försök igen senare.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <StandalonePage>
        <StandaloneHeading
          title="Sätt ett lösenord"
          sub="Du loggade in med BankID. För att aktivera tvåfaktorsautentisering eller logga in med e-post behöver du först sätta ett lösenord."
        />
        <StandaloneStack>
          {formError && <AuthFormError message={formError} />}
          <form onSubmit={handleSetPassword} className="flex flex-col gap-3">
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
            <Button type="submit" size="lg" className="w-full" loading={isLoading}>
              {isLoading ? 'Sparar...' : 'Spara lösenord'}
            </Button>
          </form>
        </StandaloneStack>
    </StandalonePage>
  )
}
