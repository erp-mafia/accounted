'use client'

import { useState, useRef, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ShieldCheck, Copy, Check, ArrowLeft } from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { userHasPassword } from '@/lib/auth/has-password'
import { safeReturnTo } from '@/lib/auth/safe-return-to'

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
  const inputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/')

  // UX defense — middleware already blocks this route for BankID-only users
  // without a password, but a stale tab might land here too. Bounce them to
  // the set-password flow before they enroll a factor they cannot later
  // un-enroll without AAL2.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()
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

    try {
      // Clean up any stale unverified factors from previous abandoned attempts
      const { data: existingFactors } = await supabase.auth.mfa.listFactors()
      if (existingFactors?.totp) {
        for (const factor of existingFactors.totp) {
          if (factor.status !== 'verified') {
            await supabase.auth.mfa.unenroll({ factorId: factor.id })
          }
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: getBranding().appName.toLowerCase(),
      })

      if (error) {
        toast({
          title: 'Kunde inte aktivera 2FA',
          description: error.message,
          variant: 'destructive',
        })
        setIsEnrolling(false)
        return
      }

      setQrCode(data.totp.qr_code)
      setSecret(data.totp.secret)
      setFactorId(data.id)

      // Focus the code input after render
      setTimeout(() => inputRef.current?.focus(), 100)
    } catch {
      toast({
        title: 'Kunde inte aktivera 2FA',
        description: 'Ett oväntat fel uppstod.',
        variant: 'destructive',
      })
    } finally {
      setIsEnrolling(false)
    }
  }

  const handleVerify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!factorId || code.length !== 6) return

    setIsVerifying(true)

    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      })

      if (challengeError) {
        toast({
          title: 'Verifiering misslyckades',
          description: 'Kunde inte starta verifiering. Försök igen.',
          variant: 'destructive',
        })
        setIsVerifying(false)
        return
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      })

      if (verifyError) {
        toast({
          title: 'Fel kod',
          description: 'Kontrollera att koden stämmer och försök igen.',
          variant: 'destructive',
        })
        setCode('')
        inputRef.current?.focus()
        setIsVerifying(false)
        return
      }

      toast({
        title: 'Tvåfaktorsautentisering aktiverad',
        description: 'Ditt konto är nu skyddat med 2FA.',
      })

      router.push(returnTo)
      router.refresh()
    } catch {
      toast({
        title: 'Verifiering misslyckades',
        description: 'Ett oväntat fel uppstod. Försök igen.',
        variant: 'destructive',
      })
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up">
          <div className="text-center mb-10">
            <div className="flex justify-center mb-4">
              <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
                <ShieldCheck className="h-7 w-7 text-primary" />
              </div>
            </div>
            <h1 className="text-2xl font-medium tracking-tight">Aktivera tvåfaktorsautentisering</h1>
            <p className="text-muted-foreground text-sm mt-2">
              Skydda ditt konto med en autentiseringsapp som Google Authenticator eller Authy
            </p>
          </div>

          <div className="rounded-lg border bg-card p-6">
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Du behöver en autentiseringsapp på din telefon. Appen genererar en
                  tidsbegränsad kod som du anger vid varje inloggning.
                </p>
              </div>
              <Button
                className="w-full h-11"
                onClick={handleEnroll}
                disabled={isEnrolling}
              >
                {isEnrolling ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Förbereder...
                  </>
                ) : (
                  'Fortsätt'
                )}
              </Button>
            </div>
          </div>

          <Button
            variant="ghost"
            className="w-full mt-4 text-muted-foreground"
            onClick={() => router.push(returnTo)}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Tillbaka
          </Button>
        </div>
      </div>
    )
  }

  // Step 2: Show QR code and verification
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <ShieldCheck className="h-7 w-7 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-medium tracking-tight">Skanna QR-koden</h1>
          <p className="text-muted-foreground text-sm mt-2">
            Öppna din autentiseringsapp och skanna koden nedan
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6 space-y-6">
          {/* QR Code */}
          <div className="flex justify-center">
            <div
              className="rounded-lg border bg-white p-3"
              dangerouslySetInnerHTML={{ __html: qrCode }}
            />
          </div>

          {/* Manual secret */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground text-center">
              Kan du inte skanna? Ange denna nyckel manuellt:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted/50 px-3 py-2 text-xs font-mono text-center break-all select-all">
                {secret}
              </code>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={copySecret}
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Verification code */}
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Ange koden från appen</Label>
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
                disabled={isVerifying}
                className="h-11 text-center text-lg tracking-[0.5em] font-mono"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11"
              disabled={isVerifying || code.length !== 6}
            >
              {isVerifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifierar...
                </>
              ) : (
                'Aktivera 2FA'
              )}
            </Button>
          </form>
        </div>

        <Button
          variant="ghost"
          className="w-full mt-4 text-muted-foreground"
          onClick={() => router.push(returnTo)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Tillbaka
        </Button>
      </div>
    </div>
  )
}
