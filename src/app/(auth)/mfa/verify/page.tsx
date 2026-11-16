'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  challengeWebauthn,
  fetchMfaStatus,
  signOutAndNavigate,
  verifiedTotpFactor,
  verifiedWebauthnFactors,
  verifyTotp,
  verifyWebauthn,
  type MfaFactor,
} from '@/lib/auth/session-client'
import { getWebauthnCredential } from '@/lib/auth/webauthn-browser'
import { Button } from '@/components/ui/button'
import { TotpCodeField } from '@/components/auth/TotpCodeField'
import { useToast } from '@/components/ui/use-toast'
import { AuthFormError } from '@/components/auth/AuthFormError'
import {
  StandaloneHeading,
  StandaloneOr,
  StandalonePage,
  StandaloneSmall,
  StandaloneStack,
} from '@/components/standalone/StandalonePage'
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
  // Failures sit in the page: a wrong code under its field, the rest over the form.
  const [codeError, setCodeError] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  // Verified security keys (crm#1448). Empty for everyone without one, and
  // then the page is exactly the TOTP page it always was.
  const [securityKeys, setSecurityKeys] = useState<MfaFactor[]>([])
  const [keyBusyId, setKeyBusyId] = useState<string | null>(null)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null)
  const [lockoutRemaining, setLockoutRemaining] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  // Step-up landing target. Set by callers that need AAL2 to do something
  // sensitive (set/change password, unenroll MFA, etc.): /api/account/password
  // and SecuritySettings redirect here when GoTrue rejects with "AAL2 session
  // is required". Falls back to the dashboard for direct visits.
  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/')

  useEffect(() => {
    async function loadFactor() {
      const status = await fetchMfaStatus()
      const verifiedFactor = verifiedTotpFactor(status)
      const keys = verifiedWebauthnFactors(status)
      setSecurityKeys(keys)
      if (verifiedFactor) {
        setFactorId(verifiedFactor.id)
      } else if (keys.length === 0) {
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
    setCodeError(null)
    setPanelError(null)

    try {
      // Challenge + verify run on the server, which writes the raised (AAL2)
      // session into the HttpOnly cookie.
      const { error: verifyError } = await verifyTotp(factorId, code)

      if (verifyError && verifyError.code?.startsWith('mfa_challenge')) {
        setPanelError(t('verify_challenge_failed_description'))
        setIsLoading(false)
        return
      }

      if (verifyError) {
        const attempts = failedAttempts + 1
        setFailedAttempts(attempts)

        if (attempts >= 3) {
          const delays = [5_000, 15_000, 30_000]
          const delay = delays[Math.min(attempts - 3, delays.length - 1)]
          setLockoutUntil(Date.now() + delay)
        }

        // The code stays so it can be compared with the app; it is selected,
        // so typing the next one replaces it.
        setCodeError(`${t('wrong_code_title')}. ${t('wrong_code_description')}`)
        inputRef.current?.focus()
        inputRef.current?.select()
        setIsLoading(false)
        return
      }

      if (await acceptPendingInvite()) {
        window.location.href = '/'
        return
      }

      // Hosted byrå staff hit MFA before any dashboard, so the cockpit
      // landing (WL-14) resolves here too: only when no explicit step-up
      // destination was requested. Everyone else keeps returnTo/'/' exactly
      // as before (the helper degrades to '/' on any failure). The session
      // is AAL2 at this point, so the /api MFA gate passes.
      //
      // Always a hard navigation, for two reasons that point the same way.
      // Route-handler destinations (e.g. the MCP OAuth consent page) return
      // raw HTML the client router cannot render. And verifying raises the
      // session to aal2, which lib/supabase/middleware.ts only re-evaluates
      // on a fresh document request: `router.push` followed by
      // `router.refresh` raced, the refresh won, and the user stayed on the
      // code screen; re-entering the same code is then rejected as reuse and
      // bumps the lockout counter (#2056, the shape #1984 fixed on enroll).
      // returnTo went through safeReturnTo and the helper only ever returns
      // '/clients' or '/', so the navigation stays same-origin.
      window.location.assign(returnTo === '/' ? await resolvePostLoginDestination() : returnTo)
    } catch {
      setPanelError(t('unexpected_error'))
    } finally {
      setIsLoading(false)
    }
  }

  // Security-key sign-in: challenge on the server, the ceremony in the
  // browser, verify on the server (which raises the session to AAL2 in the
  // HttpOnly cookie). Lands exactly where a verified TOTP code lands.
  const handleSecurityKey = async (keyId: string) => {
    setKeyBusyId(keyId)
    setCodeError(null)
    setPanelError(null)
    try {
      const started = await challengeWebauthn(keyId)
      if (started.error || !started.data) {
        setPanelError(t('verify_challenge_failed_description'))
        return
      }
      const credential = await getWebauthnCredential(started.data.publicKey)
      if (!credential) {
        setPanelError(t('security_key_cancelled'))
        return
      }
      const { error } = await verifyWebauthn({
        factorId: keyId,
        challengeId: started.data.challengeId,
        type: 'request',
        credential,
      })
      if (error) {
        setPanelError(`${t('security_key_failed_title')}. ${t('security_key_failed_description')}`)
        return
      }
      if (await acceptPendingInvite()) {
        window.location.href = '/'
        return
      }
      // Hard navigation for the same reasons as the TOTP path above.
      window.location.assign(returnTo === '/' ? await resolvePostLoginDestination() : returnTo)
    } catch {
      setPanelError(t('unexpected_error'))
    } finally {
      setKeyBusyId(null)
    }
  }

  const handleLogout = async () => {
    await signOutAndNavigate('/login')
  }

  const securityKeyButtons = securityKeys.map((key) => (
    <Button
      key={key.id}
      type="button"
      size="lg"
      variant={factorId ? 'outline' : 'default'}
      className="w-full"
      onClick={() => handleSecurityKey(key.id)}
      loading={keyBusyId === key.id}
      disabled={keyBusyId !== null}
    >
      {securityKeys.length === 1 || !key.friendly_name
        ? t('use_security_key')
        : t('use_named_security_key', { name: key.friendly_name })}
    </Button>
  ))

  return (
    <StandalonePage>
      <StandaloneHeading title={t('verify_title')} sub={t('verify_subtitle_full')} />
      <StandaloneStack>
        {panelError && <AuthFormError message={panelError} />}
        {(factorId || securityKeys.length === 0) && (
          <form onSubmit={handleVerify} className="flex flex-col gap-3">
            <TotpCodeField
              ref={inputRef}
              label={t('verify_code_label')}
              value={code}
              onChange={(next) => {
                setCode(next)
                if (codeError) setCodeError(null)
              }}
              error={codeError}
              disabled={isLoading}
            />
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={isLoading}
              disabled={code.length !== 6 || !!lockoutUntil}
            >
              {isLoading
                ? t('verifying')
                : lockoutUntil
                  ? t('wait_seconds', { seconds: lockoutRemaining })
                  : t('verify_button')}
            </Button>
          </form>
        )}
        {securityKeys.length > 0 && factorId && <StandaloneOr>{t('security_key_or')}</StandaloneOr>}
        {securityKeyButtons}
        {/* The way out of a session that cannot pass the second step. */}
        <Button variant="ghost" size="lg" className="w-full" onClick={handleLogout}>
          {tCommon('logout')}
        </Button>
      </StandaloneStack>
      <StandaloneSmall>
        {t('lost_authenticator')}{' '}
        <SupportLink variant="muted" subject="MFA: cannot sign in" className="align-bottom">
          {t('contact_support')}
        </SupportLink>
      </StandaloneSmall>
    </StandalonePage>
  )
}
