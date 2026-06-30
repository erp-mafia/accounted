'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Mail, ArrowLeft, ExternalLink } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isBankIdEnabled } from '@/lib/auth/bankid'
import { BankIdAuth } from '@/components/auth/BankIdAuth'
import type { BankIdResult } from '@/components/auth/BankIdAuth'
import { getBranding } from '@/lib/branding/service'
import { detectWebmailHint } from '@/lib/auth/webmail-search'

const branding = getBranding()

export default function RegisterPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <RegisterPageContent />
    </Suspense>
  )
}

function RegisterPageContent() {
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isRegistered, setIsRegistered] = useState(false)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState<string | null>(null)
  const [bankIdUser, setBankIdUser] = useState<{ givenName?: string; surname?: string } | null>(null)
  const [bankIdSessionId, setBankIdSessionId] = useState<string | null>(null)
  const [bankIdEmail, setBankIdEmail] = useState('')
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()
  const bankIdEnabled = isBankIdEnabled()
  const t = useTranslations('register')
  const errorLocale = useLocale() as ErrorLocale

  // When arriving from an invite link, fetch the invite info to pre-fill
  // and lock the email field so the user registers with the correct address.
  useEffect(() => {
    const inviteToken = searchParams.get('invite')
    if (!inviteToken) return

    fetch(`/api/team/accept?token=${encodeURIComponent(inviteToken)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.data?.email) {
          setInviteEmail(data.data.email)
          setEmail(data.data.email)
        }
      })
      .catch(() => {})
  }, [searchParams])

  const [bankIdUnavailable, setBankIdUnavailable] = useState(false)

  const handleBankIdComplete = (result: BankIdResult) => {
    if (result.error === 'service_unavailable') {
      setBankIdUnavailable(true)
      return
    }

    if (result.error) {
      toast({
        title: t('bankid_failed_title'),
        description: t('bankid_failed_description'),
        variant: 'destructive',
      })
      return
    }
    // BankID verified — store sessionId and show email form
    setBankIdUser({ givenName: result.givenName, surname: result.surname })
    if (result.sessionId) setBankIdSessionId(result.sessionId)
  }

  const handleBankIdSignup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('bankid_email') as string) || bankIdEmail

    try {
      const res = await fetch('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: bankIdSessionId,
          mode: 'signup',
          email: emailValue,
        }),
      })

      const json = await res.json()

      if (!res.ok) {
        if (json.error === 'already_linked') {
          toast({
            title: t('bankid_already_linked_title'),
            description: t('bankid_already_linked_description'),
            variant: 'destructive',
          })
        } else if (json.error === 'account_exists') {
          toast({
            title: t('account_exists_title'),
            description: t('account_exists_description'),
            variant: 'destructive',
          })
          router.push('/login')
        } else {
          toast({
            title: t('register_failed_title'),
            description: json.message || json.error || t('register_failed_default'),
            variant: 'destructive',
          })
        }
        return
      }

      // Exchange token hash for Supabase session
      const { error } = await supabase.auth.verifyOtp({
        token_hash: json.data.tokenHash,
        type: json.data.type as 'magiclink',
      })

      if (error) {
        console.error('[register] BankID verifyOtp failed', error.message)
        toast({
          title: t('register_failed_complete'),
          description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }

      router.push('/select-company')
      router.refresh()
    } catch (error) {
      console.error('[register] BankID signup error', error instanceof Error ? error.message : String(error))
      toast({
        title: t('register_failed_title'),
        description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  function isStrongPassword(pw: string): boolean {
    return pw.length >= 8
      && /[a-z]/.test(pw)
      && /[A-Z]/.test(pw)
      && /[0-9]/.test(pw)
      && /[^a-zA-Z0-9]/.test(pw)
  }

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password
    const confirmValue = (formData.get('confirm_password') as string) || confirmPassword

    if (!isStrongPassword(passwordValue)) {
      toast({
        title: t('weak_password_title'),
        description: t('weak_password_description'),
        variant: 'destructive',
      })
      setIsLoading(false)
      return
    }

    if (passwordValue !== confirmValue) {
      toast({
        title: t('password_mismatch_title'),
        description: t('password_mismatch_description'),
        variant: 'destructive',
      })
      setIsLoading(false)
      return
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        email: emailValue,
        password: passwordValue,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })

      if (error) {
        console.error('[register] signUp error', error.message)
        toast({
          title: t('register_failed_title'),
          description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }

      // If auto-confirmed (local dev), process invite immediately and redirect
      if (data.session) {
        const cookieMatch = document.cookie.match(/gnubok-invite-token=([^;]+)/)
        const inviteToken = cookieMatch?.[1]

        if (inviteToken) {
          try {
            const res = await fetch('/api/team/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: inviteToken }),
            })

            if (res.ok) {
              document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
              window.location.href = '/'
              return
            }
          } catch (err) {
            console.error('[register] invite acceptance failed:', err instanceof Error ? err.message : String(err))
          }
        }

        // Auto-confirmed but no invite or invite failed — go to onboarding
        // (invite cookie is preserved so the onboarding fallback can retry)
        window.location.href = '/'
        return
      }

      // Supabase obfuscates duplicate signups (to prevent user enumeration):
      // when the email already belongs to a confirmed account, it returns
      // data.user with identities: [] and no error, and sends no email.
      // Detect that case so we don't show a misleading "check your email" screen.
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        setDuplicateEmail(emailValue)
        return
      }

      setEmail(emailValue)
      setIsRegistered(true)
    } catch (error) {
      console.error('[register] unexpected exception', error instanceof Error ? error.message : String(error))
      toast({
        title: t('register_failed_title'),
        description: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (duplicateEmail) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{t('duplicate_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t('duplicate_body_prefix')}{' '}
              <span className="font-medium text-foreground">{duplicateEmail}</span>.
            </p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('duplicate_hint')}
            </p>
          </div>

          <div className="space-y-2">
            <Button className="w-full" asChild>
              <Link href={`/login?email=${encodeURIComponent(duplicateEmail)}`}>
                {t('sign_in')}
              </Link>
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setDuplicateEmail(null)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (isRegistered) {
    const webmailHint = detectWebmailHint(email, branding.authEmailFrom)

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{t('confirm_email_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t.rich('confirm_email_body', {
                email,
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('confirm_email_hint')}
            </p>
          </div>

          <div className="space-y-2">
            {webmailHint && (
              <Button className="w-full" asChild>
                <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                  {t(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                    provider: webmailHint.name,
                  })}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
            <Button variant="ghost" className="w-full text-muted-foreground" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back_to_login')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-background to-primary/[0.03] p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="text-center mb-10">
          <BrandWordmark size="hero" className="mb-2" />
          <p className="text-muted-foreground text-sm mt-3">
            {t('subtitle')}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-6">
          {bankIdEnabled && !bankIdUser && (
            <>
              <div className="mb-5">
                <BankIdAuth mode="signup" onComplete={handleBankIdComplete} />
              </div>
              <div className="relative mb-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">{t('or_email_divider')}</span>
                </div>
              </div>
            </>
          )}

          {bankIdUnavailable && !bankIdUser && (
            <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                {t('bankid_unavailable_body')}
              </p>
            </div>
          )}

          {bankIdUser ? (
            <form onSubmit={handleBankIdSignup} className="space-y-5">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-sm font-medium">
                  {bankIdUser.givenName} {bankIdUser.surname}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('bankid_verified')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bankid_email">{t('email_label')}</Label>
                <Input
                  id="bankid_email"
                  name="bankid_email"
                  type="email"
                  autoComplete="email"
                  placeholder={t('email_placeholder')}
                  value={bankIdEmail}
                  onChange={(e) => setBankIdEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  className="h-11"
                />
                <p className="text-xs text-muted-foreground">
                  {t('bankid_email_hint')}
                </p>
              </div>
              <Button type="submit" className="w-full h-11" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : (
                  t('create_account')
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={() => {
                  setBankIdUser(null)
                  setBankIdSessionId(null)
                }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back')}
              </Button>
            </form>
          ) : (
          <form onSubmit={handleRegister} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">{t('email_label')}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={t('email_placeholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading || !!inviteEmail}
                readOnly={!!inviteEmail}
                className="h-11"
              />
              {inviteEmail && (
                <p className="text-xs text-muted-foreground">
                  {t('invite_email_hint')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('password_label')}</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder={t('password_placeholder')}
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
                name="confirm_password"
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
                  {t('creating')}
                </>
              ) : (
                t('create_account')
              )}
            </Button>
          </form>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t('already_have_account')}{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline underline-offset-2 hover:text-primary transition-colors"
          >
            {t('sign_in')}
          </Link>
        </p>

        <p className="mt-4 text-center text-xs text-muted-foreground leading-relaxed">
          {t('terms_prefix')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {t('terms_link')}
          </a>{' '}
          {t('terms_and')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {t('privacy_link')}
          </a>
          .
        </p>
      </div>
    </div>
  )
}
