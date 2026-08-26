'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import { isMfaRequired } from '@/lib/auth/mfa'
import { isBankIdEnabled } from '@/lib/auth/bankid-flags'
import { isSelfHosted as readSelfHostedFlag } from '@/lib/env/public-flags'
import { AutoLogoutToggle } from '@/components/settings/AutoLogoutToggle'
import { BankIdSettings } from '@/components/settings/BankIdSettings'
import { userHasPassword } from '@/lib/auth/has-password'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'

const isSelfHosted = readSelfHostedFlag()
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
          description: getUserErrorMessage(error),
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
    <SettingsGroup label={t('group_security')}>
      {bankIdEnabled && <BankIdSettings />}

      {/* BankID-only users with no password: set-password row before the rest */}
      {hasPassword === false && (
        <SettingsRow
          label={t('set_password_title')}
          help={t('set_password_description')}
        >
          <SettingsRowEnd>
            <Button
              size="sm"
              onClick={() =>
                router.push('/account/set-password?returnTo=/settings/account')
              }
            >
              {t('set_password_button')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      )}

      {/* Change password: hidden when the user has no password (the row
          above handles the set-initial-password flow). */}
      {hasPassword !== false && (
        <form onSubmit={handleChangePassword}>
          <SettingsRow
            label={t('new_password_label')}
            htmlFor="new_password"
            help={t('change_password_description')}
            align="baseline"
          >
            <SettingsInput
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
          </SettingsRow>
          <SettingsRow
            label={t('confirm_password_label')}
            htmlFor="confirm_new_password"
            align="baseline"
          >
            <SettingsInput
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
            <SettingsRowEnd>
              <Button type="submit" size="sm" disabled={isChangingPassword}>
                {isChangingPassword ? (
                  <>
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    {t('saving')}
                  </>
                ) : (
                  t('update_password_button')
                )}
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
        </form>
      )}

      {/* MFA: hidden for self-hosted */}
      {!isSelfHosted && (
        <SettingsRow
          label={t('mfa_title')}
          help={
            <>
              <p>{t('mfa_description')}</p>
              {!isLoadingMfa && !hasMfa && (
                <p className="mt-2">{t('mfa_inactive_description')}</p>
              )}
            </>
          }
        >
          {isLoadingMfa ? (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('loading')}
            </span>
          ) : hasMfa ? (
            <>
              <Badge variant="success">{t('mfa_active_title')}</Badge>
              <SettingsRowNote>{t('mfa_active_description')}</SettingsRowNote>
              <SettingsRowEnd>
                {mfaRequired ? (
                  // Required by the hosted config: no disable action exists,
                  // so the reason stays visible as the row's status.
                  <SettingsRowNote>{t('mfa_required_note')}</SettingsRowNote>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUnenrollMfa}
                    disabled={isUnenrolling}
                  >
                    {isUnenrolling ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        {t('disabling')}
                      </>
                    ) : (
                      <>
                        <ShieldOff className="mr-2 h-3.5 w-3.5" />
                        {t('disable_mfa')}
                      </>
                    )}
                  </Button>
                )}
              </SettingsRowEnd>
            </>
          ) : (
            <>
              <SettingsRowNote>{t('mfa_inactive_title')}</SettingsRowNote>
              <SettingsRowEnd>
                {hasPassword === false ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      router.push('/account/set-password?returnTo=/mfa/enroll')
                    }
                  >
                    {t('set_password_first')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      router.push(`/mfa/enroll?returnTo=${encodeURIComponent('/settings/account')}`)
                    }
                  >
                    <ShieldCheck className="mr-2 h-3.5 w-3.5" />
                    {t('enable_mfa')}
                  </Button>
                )}
              </SettingsRowEnd>
            </>
          )}
        </SettingsRow>
      )}

      {/* Automatic logout: per-user opt-in, renders nothing on self-hosted */}
      <AutoLogoutToggle />
    </SettingsGroup>
  )
}
