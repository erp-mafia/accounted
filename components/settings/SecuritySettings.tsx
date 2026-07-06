'use client'

import { useTranslations } from 'next-intl'
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
import { isBankIdEnabled } from '@/lib/auth/bankid'
import { BankIdSettings } from '@/components/settings/BankIdSettings'
import { userHasPassword } from '@/lib/auth/has-password'

const isSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
const mfaRequired = isMfaRequired()
const bankIdEnabled = isBankIdEnabled()

export function SecuritySettings() {
  const t = useTranslations('settings_security')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [hasMfa, setHasMfa] = useState(false)
  const [isLoadingMfa, setIsLoadingMfa] = useState(true)
  const [isUnenrolling, setIsUnenrolling] = useState(false)
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null)
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function loadStatus() {
      const [{ data: factors }, { data: userData }] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.getUser(),
      ])
      const verifiedFactor = factors?.totp?.find(f => f.status === 'verified')
      setHasMfa(!!verifiedFactor)
      setMfaFactorId(verifiedFactor?.id ?? null)
      setHasPassword(userData?.user ? userHasPassword(userData.user) : null)
      setIsLoadingMfa(false)
    }
    loadStatus()
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
        title: t('toast_weak_password_title'),
        description: t('toast_weak_password_description'),
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: t('toast_mismatch_title'),
        description: t('toast_mismatch_description'),
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        // Supabase rejects updateUser({password}) with this exact message when
        // the user has a TOTP factor enrolled but is at AAL1. Send them through
        // /mfa/verify to step up; on return they land back here and can retry.
        if (body.error?.includes('AAL2')) {
          router.push(
            `/mfa/verify?returnTo=${encodeURIComponent('/settings/account')}`,
          )
          return
        }
        toast({
          title: t('toast_update_failed_title'),
          description: body.error || t('toast_update_failed_description'),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('toast_password_updated_title'),
        description: t('toast_password_updated_description'),
      })
      setNewPassword('')
      setConfirmPassword('')
      setHasPassword(true)
    } catch {
      toast({
        title: t('toast_generic_error_title'),
        description: t('toast_try_again'),
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
        // mfa.unenroll requires AAL2: for BankID-linked users at AAL1 (the
        // shouldEnforceMfa skip path), this is the only way to step up.
        if (error.message?.includes('AAL2')) {
          router.push(
            `/mfa/verify?returnTo=${encodeURIComponent('/settings/account')}`,
          )
          return
        }
        toast({
          title: t('toast_unenroll_failed_title'),
          description: error.message,
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('toast_mfa_disabled_title'),
        description: t('toast_mfa_disabled_description'),
      })
      setHasMfa(false)
      setMfaFactorId(null)
    } catch {
      toast({
        title: t('toast_generic_error_title'),
        description: t('toast_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsUnenrolling(false)
    }
  }

  return (
    <div className="space-y-6">
      {bankIdEnabled && <BankIdSettings />}

      {/* BankID-only users with no password: banner above everything else */}
      {hasPassword === false && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Sätt ett lösenord
            </CardTitle>
            <CardDescription>
              Du loggade in med BankID och har inget lösenord ännu. Sätt ett
              lösenord för att kunna aktivera 2FA eller logga in när BankID
              inte är tillgängligt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() =>
                router.push('/account/set-password?returnTo=/settings/account')
              }
            >
              Sätt lösenord
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Change password: hidden when the user has no password (the banner
          above handles the set-initial-password flow). */}
      {hasPassword !== false && (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {t('change_password_title')}
          </CardTitle>
          <CardDescription>
            {t('change_password_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="new_password">{t('new_password_label')}</Label>
              <Input
                id="new_password"
                type="password"
                autoComplete="new-password"
                placeholder={t('new_password_placeholder')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                disabled={isChangingPassword}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_new_password">{t('confirm_password_label')}</Label>
              <Input
                id="confirm_new_password"
                type="password"
                autoComplete="new-password"
                placeholder={t('confirm_password_placeholder')}
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
                  {t('saving')}
                </>
              ) : (
                t('update_password_button')
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
      )}

      {/* MFA: hidden for self-hosted */}
      {!isSelfHosted && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              {t('mfa_title')}
            </CardTitle>
            <CardDescription>
              {t('mfa_description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingMfa ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('loading')}
              </div>
            ) : hasMfa ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-lg border border-border bg-secondary">
                  <ShieldCheck className="h-5 w-5 text-success" />
                  <div>
                    <p className="font-medium text-foreground">{t('mfa_active_title')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('mfa_active_description')}
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
                        {t('disabling')}
                      </>
                    ) : (
                      <>
                        <ShieldOff className="mr-2 h-4 w-4" />
                        {t('disable_mfa')}
                      </>
                    )}
                  </Button>
                )}
                {mfaRequired && (
                  <p className="text-xs text-muted-foreground">
                    {t('mfa_required_note')}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-lg border">
                  <ShieldOff className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium">{t('mfa_inactive_title')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('mfa_inactive_description')}
                    </p>
                  </div>
                </div>
                {hasPassword === false ? (
                  <Button
                    onClick={() =>
                      router.push(
                        '/account/set-password?returnTo=/mfa/enroll',
                      )
                    }
                  >
                    {t('set_password_first')}
                  </Button>
                ) : (
                  <Button
                    onClick={() => router.push(`/mfa/enroll?returnTo=${encodeURIComponent('/settings/account')}`)}
                  >
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    {t('enable_mfa')}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
