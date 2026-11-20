'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  enrollWebauthn,
  fetchMfaStatus,
  isInsufficientAal,
  unenrollFactor,
  verifyWebauthn,
  verifiedWebauthnFactors,
  type MfaFactor,
} from '@/lib/auth/session-client'
import { browserSupportsWebauthn, createWebauthnCredential } from '@/lib/auth/webauthn-browser'
import { isWebauthnMfaEnabled } from '@/lib/auth/webauthn-mfa'
import { isMfaRequired } from '@/lib/auth/mfa'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'

const webauthnEnabled = isWebauthnMfaEnabled()
const mfaRequired = isMfaRequired()
const STEP_UP_URL = `/mfa/verify?returnTo=${encodeURIComponent('/settings/account')}`

/**
 * Security keys (WebAuthn) as a second factor next to TOTP (crm#1448).
 * Renders nothing unless NEXT_PUBLIC_WEBAUTHN_MFA_ENABLED is on, so the
 * security settings stay exactly as they were until the flag flips.
 *
 * Adding a key while another factor is verified needs an AAL2 session
 * (GoTrue's rule), and so does removing one: both refusals send the user
 * through /mfa/verify, like the TOTP row. Where MFA is mandatory the last
 * remaining factor cannot be removed here.
 */
export function SecurityKeySettings() {
  if (!webauthnEnabled) return null
  return <SecurityKeyRow />
}

function SecurityKeyRow() {
  const t = useTranslations('settings_security')
  const { toast } = useToast()
  const router = useRouter()
  const [keys, setKeys] = useState<MfaFactor[] | null>(null)
  const [verifiedCount, setVerifiedCount] = useState(0)
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [supported, setSupported] = useState(true)

  const load = useCallback(async () => {
    const status = await fetchMfaStatus()
    setKeys(verifiedWebauthnFactors(status))
    setVerifiedCount(status?.factors.filter((factor) => factor.status === 'verified').length ?? 0)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(browserSupportsWebauthn())
    void load()
  }, [load])

  const handleAdd = async () => {
    setAdding(true)
    try {
      const started = await enrollWebauthn()
      if (started.error || !started.data) {
        if (isInsufficientAal(started.error)) {
          router.push(STEP_UP_URL)
          return
        }
        toast({
          title: t('toast_security_key_failed_title'),
          description: getUserErrorMessage(started.error),
          variant: 'destructive',
        })
        return
      }
      const credential = await createWebauthnCredential(started.data.publicKey)
      if (!credential) {
        toast({ title: t('toast_security_key_failed_title'), description: t('toast_security_key_cancelled') })
        return
      }
      const { error } = await verifyWebauthn({
        factorId: started.data.factorId,
        challengeId: started.data.challengeId,
        type: 'create',
        credential,
      })
      if (error) {
        toast({
          title: t('toast_security_key_failed_title'),
          description: getUserErrorMessage(error),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('toast_security_key_added_title'), description: t('toast_security_key_added_description') })
      await load()
    } catch {
      toast({ title: t('toast_security_key_failed_title'), description: t('toast_try_again'), variant: 'destructive' })
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (factorId: string) => {
    setRemovingId(factorId)
    try {
      const { error } = await unenrollFactor(factorId)
      if (error) {
        if (isInsufficientAal(error)) {
          router.push(STEP_UP_URL)
          return
        }
        toast({
          title: t('toast_security_key_remove_failed_title'),
          description: getUserErrorMessage(error),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('toast_security_key_removed_title') })
      await load()
    } catch {
      toast({ title: t('toast_security_key_remove_failed_title'), description: t('toast_try_again'), variant: 'destructive' })
    } finally {
      setRemovingId(null)
    }
  }

  // Mandatory MFA: the last verified factor stays (same rule as the TOTP row).
  const canRemove = !mfaRequired || verifiedCount > 1

  return (
    <SettingsRow label={t('security_keys_title')} help={t('security_keys_description')}>
      {keys === null ? null : keys.length === 0 ? (
        <SettingsRowNote>{t('security_keys_none')}</SettingsRowNote>
      ) : (
        <ul className="basis-full space-y-1">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3">
              <span className="truncate">{key.friendly_name ?? t('security_keys_title')}</span>
              {canRemove && (
                <Button
                  variant="ghost"
                  onClick={() => handleRemove(key.id)}
                  loading={removingId === key.id}
                  disabled={removingId !== null}
                  aria-label={t('remove_security_key_aria', { name: key.friendly_name ?? t('security_keys_title') })}
                >
                  {t('remove_security_key')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <SettingsRowEnd>
        {supported ? (
          <Button variant="outline" onClick={handleAdd} loading={adding} disabled={keys === null}>
            {adding ? t('adding_security_key') : t('add_security_key')}
          </Button>
        ) : (
          <SettingsRowNote>{t('security_key_unsupported')}</SettingsRowNote>
        )}
      </SettingsRowEnd>
    </SettingsRow>
  )
}
