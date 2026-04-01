'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ShieldCheck, ShieldOff, KeyRound } from 'lucide-react'
import { isMfaRequired } from '@/lib/auth/mfa'

const isSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
const mfaRequired = isMfaRequired()

export function SecuritySettings() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [hasMfa, setHasMfa] = useState(false)
  const [isLoadingMfa, setIsLoadingMfa] = useState(true)
  const [isUnenrolling, setIsUnenrolling] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function loadMfaStatus() {
      const { data } = await supabase.auth.mfa.listFactors()
      const verifiedFactor = data?.totp?.find(f => f.status === 'verified')
      setHasMfa(!!verifiedFactor)
      setMfaFactorId(verifiedFactor?.id ?? null)
      setIsLoadingMfa(false)
    }
    loadMfaStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChangePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsChangingPassword(true)

    const strong = newPassword.length >= 8
      && /[a-z]/.test(newPassword)
      && /[A-Z]/.test(newPassword)
      && /[0-9]/.test(newPassword)
      && /[^a-zA-Z0-9]/.test(newPassword)

    if (!strong) {
      toast({
        title: 'Lösenordet är för svagt',
        description: 'Lösenordet måste vara minst 8 tecken och innehålla versaler, gemener, siffror och specialtecken.',
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: 'Lösenorden matchar inte',
        description: 'Kontrollera att du skrev samma lösenord i båda fälten.',
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })

      if (error) {
        toast({
          title: 'Kunde inte uppdatera lösenord',
          description: error.message,
          variant: 'destructive',
        })
        return
      }

      toast({
        title: 'Lösenord uppdaterat',
        description: 'Ditt lösenord har ändrats.',
      })
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      toast({
        title: 'Något gick fel',
        description: 'Försök igen senare.',
        variant: 'destructive',
      })
    } finally {
      setIsChangingPassword(false)
    }
  }

  const handleUnenrollMfa = async () => {
    if (!mfaFactorId) return
    setIsUnenrolling(true)

    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId })

      if (error) {
        toast({
          title: 'Kunde inte inaktivera 2FA',
          description: error.message,
          variant: 'destructive',
        })
        return
      }

      toast({
        title: 'Tvåfaktorsautentisering inaktiverad',
        description: '2FA har tagits bort från ditt konto.',
      })
      setHasMfa(false)
      setMfaFactorId(null)
    } catch {
      toast({
        title: 'Något gick fel',
        description: 'Försök igen senare.',
        variant: 'destructive',
      })
    } finally {
      setIsUnenrolling(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Change password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            Ändra lösenord
          </CardTitle>
          <CardDescription>
            Uppdatera ditt lösenord. Om du loggar in med e-postlänk kan du sätta ett lösenord här.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="new_password">Nytt lösenord</Label>
              <Input
                id="new_password"
                type="password"
                autoComplete="new-password"
                placeholder="Minst 8 tecken"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                disabled={isChangingPassword}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_new_password">Bekräfta nytt lösenord</Label>
              <Input
                id="confirm_new_password"
                type="password"
                autoComplete="new-password"
                placeholder="Upprepa lösenordet"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                disabled={isChangingPassword}
              />
            </div>
            <Button type="submit" disabled={isChangingPassword}>
              {isChangingPassword ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sparar...
                </>
              ) : (
                'Uppdatera lösenord'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* MFA — hidden for self-hosted */}
      {!isSelfHosted && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Tvåfaktorsautentisering (2FA)
            </CardTitle>
            <CardDescription>
              Skydda ditt konto med en autentiseringsapp. Vid varje inloggning behöver du ange en kod
              utöver ditt lösenord.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingMfa ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Laddar...
              </div>
            ) : hasMfa ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-lg border bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900">
                  <ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-500" />
                  <div>
                    <p className="font-medium text-green-900 dark:text-green-100">2FA är aktiverad</p>
                    <p className="text-sm text-green-700 dark:text-green-400">
                      Ditt konto skyddas med tvåfaktorsautentisering.
                    </p>
                  </div>
                </div>
                {!mfaRequired && (
                  <Button
                    variant="outline"
                    onClick={handleUnenrollMfa}
                    disabled={isUnenrolling}
                  >
                    {isUnenrolling ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Inaktiverar...
                      </>
                    ) : (
                      <>
                        <ShieldOff className="mr-2 h-4 w-4" />
                        Inaktivera 2FA
                      </>
                    )}
                  </Button>
                )}
                {mfaRequired && (
                  <p className="text-xs text-muted-foreground">
                    Tvåfaktorsautentisering är obligatorisk och kan inte inaktiveras.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-lg border">
                  <ShieldOff className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">2FA är inte aktiverad</p>
                    <p className="text-sm text-muted-foreground">
                      Vi rekommenderar att du aktiverar tvåfaktorsautentisering.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => router.push(`/mfa/enroll?returnTo=${encodeURIComponent('/settings/account')}`)}
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Aktivera 2FA
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
