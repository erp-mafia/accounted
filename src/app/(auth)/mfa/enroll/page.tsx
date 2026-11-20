'use client'

import { useState, useRef, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { enrollTotp, fetchSessionUser, verifyTotp } from '@/lib/auth/session-client'
import { Button } from '@/components/ui/button'
import { TotpCodeField } from '@/components/auth/TotpCodeField'
import { useToast } from '@/components/ui/use-toast'
import { CheckIcon, Square2StackIcon } from '@/components/icons'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { StandaloneHeading, StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'
import { getBranding } from '@/lib/branding/service'
import { userHasPassword } from '@/lib/auth/has-password'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export default function MfaEnrollPage() {
  return (
    <Suspense>
      <MfaEnrollContent />
    </Suspense>
  )
}

function MfaEnrollContent() {
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [isEnrolling, setIsEnrolling] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [copied, setCopied] = useState(false)
  // Failures sit in the page: a wrong code under its field, the rest over the form.
  const [codeError, setCodeError] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const t = useTranslations('mfa')
  const router = useRouter()
  const searchParams = useSearchParams()

  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/')

  // Always a hard navigation, for two reasons that point the same way.
  // Route-handler destinations (the MCP OAuth consent page sends new
  // password accounts here with returnTo=/api/mcp-oauth/authorize...) return
  // raw HTML the client router cannot render. And enrolling raises the
  // session to aal2, which lib/supabase/middleware.ts only re-evaluates on a
  // fresh document request: `router.push` followed by `router.refresh` raced,
  // the refresh won, and the user was left on the QR screen with 2FA already
  // active and no way forward but the address bar (#1948).
  const leave = () => {
    window.location.assign(returnTo)
  }
  // Back must not bounce into the consent page: with no factor enrolled it
  // redirects straight back here. Abort the connect flow to the app instead.
  const abort = () => {
    router.push(returnTo.startsWith('/api/') ? '/' : returnTo)
  }

  // UX defense: middleware already blocks this route for BankID-only users
  // without a password, but a stale tab might land here too. Bounce them to
  // the set-password flow before they enroll a factor they cannot later
  // un-enroll without AAL2.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const user = await fetchSessionUser()
      if (cancelled || !user) return
      if (!userHasPassword(user)) {
        router.replace(
          `/account/set-password?returnTo=${encodeURIComponent(
            `/mfa/enroll?returnTo=${encodeURIComponent(returnTo)}`,
          )}`,
        )
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleEnroll = async () => {
    setIsEnrolling(true)
    setPanelError(null)

    try {
      // The server removes stale unverified factors from abandoned attempts
      // first, then enrols a new TOTP factor.
      const { data, error } = await enrollTotp(getBranding().appName.toLowerCase())

      if (error || !data) {
        setPanelError(getUserErrorMessage(error))
        setIsEnrolling(false)
        return
      }

      setQrCode(data.qrCode)
      setSecret(data.secret)
      setFactorId(data.id)

      // Focus the code input after render
      setTimeout(() => inputRef.current?.focus(), 100)
    } catch {
      setPanelError('Kunde inte aktivera 2FA. Ett oväntat fel uppstod.')
    } finally {
      setIsEnrolling(false)
    }
  }

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!factorId || code.length !== 6) return

    setIsVerifying(true)
    setCodeError(null)
    setPanelError(null)

    try {
      // Challenge + verify on the server; success raises the session to
      // AAL2 in the HttpOnly cookie.
      const { error: verifyError } = await verifyTotp(factorId, code)

      if (verifyError && verifyError.code?.startsWith('mfa_challenge')) {
        setPanelError('Kunde inte starta verifiering. Försök igen.')
        setIsVerifying(false)
        return
      }

      if (verifyError) {
        // The code stays so it can be compared with the app; it is selected,
        // so typing the next one replaces it.
        setCodeError('Fel kod. Kontrollera att koden stämmer och försök igen.')
        inputRef.current?.focus()
        inputRef.current?.select()
        setIsVerifying(false)
        return
      }

      toast({
        title: 'Tvåfaktorsautentisering aktiverad',
        description: 'Ditt konto är nu skyddat med 2FA.',
      })

      leave()
    } catch {
      setPanelError('Verifiering misslyckades. Ett oväntat fel uppstod. Försök igen.')
    } finally {
      setIsVerifying(false)
    }
  }

  const copySecret = async () => {
    if (!secret) return
    await navigator.clipboard.writeText(secret)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Step 1: Show enroll button
  if (!qrCode) {
    return (
      <StandalonePage>
        <StandaloneHeading
          title="Aktivera tvåfaktorsautentisering"
          sub="Skydda ditt konto med en autentiseringsapp som Google Authenticator eller Authy"
        />
        <StandaloneStack>
          {panelError && <AuthFormError message={panelError} />}
          <p className="text-sm text-foreground">
            Du behöver en autentiseringsapp på din telefon. Appen genererar en
            tidsbegränsad kod som du anger vid varje inloggning.
          </p>
          <Button size="lg" className="w-full" onClick={handleEnroll} loading={isEnrolling}>
            {isEnrolling ? 'Förbereder...' : 'Fortsätt'}
          </Button>
          <Button variant="ghost" size="lg" className="w-full" onClick={abort}>
            Tillbaka
          </Button>
        </StandaloneStack>
      </StandalonePage>
    )
  }

  // Step 2: Show QR code and verification
  return (
    <StandalonePage>
      <StandaloneHeading title="Skanna QR-koden" sub="Öppna din autentiseringsapp och skanna koden nedan" />
      <StandaloneStack>
        {panelError && <AuthFormError message={panelError} />}
        {/* QR code: always dark on white, so every scanner reads it in both themes. */}
        <div className="flex justify-center">
          {/* The auth client hands the QR as an SVG data URL; only the markup after the prefix is drawn, or the prefix shows as text above the code. */}
          <div
            className="rounded-lg bg-white p-3 shadow-raised"
            dangerouslySetInnerHTML={{ __html: qrCode.replace(/^data:image\/svg\+xml;utf-8,/, '') }}
          />
        </div>

        {/* Manual secret */}
        <div>
          <p className="text-xs font-medium text-muted-foreground">Kan du inte skanna? Ange denna nyckel manuellt:</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px] text-strong">{secret}</code>
            <Button variant="ghost" className="shrink-0" onClick={copySecret}>
              {copied ? <CheckIcon className="h-4 w-4" /> : <Square2StackIcon className="h-4 w-4" />}
              {t('copy_secret')}
            </Button>
          </div>
        </div>

        {/* Verification code */}
        <form onSubmit={handleVerify} className="flex flex-col gap-3">
            <TotpCodeField
              ref={inputRef}
              label="Ange koden från appen"
              value={code}
              onChange={(next) => {
                setCode(next)
                if (codeError) setCodeError(null)
              }}
              error={codeError}
              disabled={isVerifying}
            />
          <Button type="submit" size="lg" className="w-full" loading={isVerifying} disabled={code.length !== 6}>
            {isVerifying ? 'Verifierar...' : 'Aktivera 2FA'}
          </Button>
        </form>
        <Button variant="ghost" size="lg" className="w-full" onClick={abort}>
          Tillbaka
        </Button>
      </StandaloneStack>
    </StandalonePage>
  )
}
