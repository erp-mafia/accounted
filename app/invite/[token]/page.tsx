'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Loader2, Building2, AlertCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

interface InviteInfo {
  type: 'company'
  companyName?: string
  email: string
  expired: boolean
  alreadyHasAccount: boolean
}

export default function InvitePage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('invite')
  const token = params.token as string

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  // Email of the currently signed-in user (if any). Used to short-circuit
  // the login redirect for users who are already authenticated.
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null)
  const [isJoining, setIsJoining] = useState(false)

  useEffect(() => {
    async function loadInvite() {
      try {
        // Load invite info and current session in parallel — the page needs
        // both to decide which CTA to render.
        const supabase = createClient()
        const [inviteRes, sessionRes] = await Promise.all([
          fetch(`/api/team/accept?token=${encodeURIComponent(token)}`),
          supabase.auth.getUser(),
        ])

        const data = await inviteRes.json()
        if (!inviteRes.ok) {
          setError(data.error || t('invalid_invite'))
          return
        }

        setInvite(data.data)
        setCurrentUserEmail(sessionRes.data.user?.email ?? null)
      } catch {
        setError(t('load_failed'))
      } finally {
        setIsLoading(false)
      }
    }
    loadInvite()
  }, [token, t])

  const secureCookieFlag = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; secure' : ''

  // True when the signed-in user's email matches the invite — in that case
  // we can accept the invite with a single click, no re-login required.
  const isLoggedInAsInvitee =
    !!currentUserEmail &&
    !!invite &&
    currentUserEmail.toLowerCase() === invite.email.toLowerCase()

  // True when someone is signed in but with a different email than the
  // invite is for. They need to sign out first.
  const isLoggedInAsOther =
    !!currentUserEmail && !!invite && !isLoggedInAsInvitee

  const handleAccept = () => {
    // Store invite token in cookie before redirecting to register
    document.cookie = `gnubok-invite-token=${token}; path=/; max-age=3600; samesite=lax${secureCookieFlag}`
    router.push(`/register?invite=${encodeURIComponent(token)}`)
  }

  const handleAcceptExistingUser = () => {
    // Store invite token in cookie before redirecting to login
    document.cookie = `gnubok-invite-token=${token}; path=/; max-age=3600; samesite=lax${secureCookieFlag}`
    router.push('/login')
  }

  // Already signed in as the invitee — accept directly, no login detour.
  // POST /api/team/accept handles the membership insert + sets the active
  // company; we then full-reload to '/' so middleware picks up the new
  // company context and the switcher shows it.
  const handleJoinNow = async () => {
    setIsJoining(true)
    try {
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const body = await res.json().catch(() => ({}))

      if (!res.ok) {
        toast({
          title: t('join_failed_title'),
          description: body.error || t('unexpected_error'),
          variant: 'destructive',
        })
        setIsJoining(false)
        return
      }

      toast({
        title: t('welcome_title'),
        description: invite?.companyName
          ? t('joined_named', { companyName: invite.companyName })
          : t('joined_generic'),
      })
      // Full reload so the middleware re-resolves company context from the
      // updated user_preferences.active_company_id.
      window.location.href = '/'
    } catch (err) {
      console.error('[invite] join failed:', err)
      toast({
        title: t('join_failed_title'),
        description: t('unexpected_error'),
        variant: 'destructive',
      })
      setIsJoining(false)
    }
  }

  const handleSignOutAndRetry = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    // Keep the invite cookie alive so the next login/register picks it up.
    document.cookie = `gnubok-invite-token=${token}; path=/; max-age=3600; samesite=lax${secureCookieFlag}`
    if (invite?.alreadyHasAccount) {
      router.push('/login')
    } else {
      router.push(`/register?invite=${encodeURIComponent(token)}`)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="relative bg-[#141414] text-white overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(ellipse at 30% -20%, rgba(255,255,255,0.04) 0%, transparent 50%)',
            }}
          />
        </div>
        <div className="relative z-10 max-w-2xl mx-auto w-full px-6 md:px-10 pt-5 pb-6 md:pt-6 md:pb-8">
          <div className="flex items-center gap-2.5 mb-5 md:mb-6">
            <span className="font-display text-base tracking-tight" style={{ fontWeight: 700 }}>
              {branding.appName.toLowerCase()}
            </span>
          </div>
          <div className="animate-fade-in">
            <h1 className="font-display text-2xl md:text-3xl tracking-tight leading-[1.1]">
              {error ? t('header_invalid') : t('header_invited')}
            </h1>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <div className="max-w-lg mx-auto px-6 md:px-10 py-6 md:py-8">
          <div className="animate-slide-up">
            {error ? (
              <Card className="p-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">{error}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('contact_inviter')}
                    </p>
                    <Link
                      href="/login"
                      className="text-sm text-primary hover:underline mt-3 inline-block"
                    >
                      {t('go_to_login')}
                    </Link>
                  </div>
                </div>
              </Card>
            ) : invite?.expired ? (
              <Card className="p-6">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">{t('expired_title')}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('expired_description')}
                    </p>
                  </div>
                </div>
              </Card>
            ) : isLoggedInAsInvitee ? (
              // Already signed in as the invitee — one-click join.
              // Prioritized over alreadyHasAccount to avoid the broken flow
              // where a false-negative from the email check would send a
              // logged-in user to /register, which middleware bounces to /.
              <div className="space-y-6">
                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="p-2.5 rounded-lg bg-muted/50">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{invite.companyName}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t('invited_to_company')}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t.rich('logged_in_as', {
                          email: currentUserEmail ?? '',
                          strong: (chunks) => <strong>{chunks}</strong>,
                        })}
                      </p>
                    </div>
                  </div>
                </Card>

                <Button
                  size="lg"
                  className="w-full"
                  onClick={handleJoinNow}
                  disabled={isJoining}
                >
                  {isJoining ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('joining')}
                    </>
                  ) : (
                    <>{t('join_named', { companyName: invite.companyName ?? '' })}</>
                  )}
                </Button>
              </div>
            ) : isLoggedInAsOther ? (
              // Signed in as a different user — ask them to sign out first.
              <div className="space-y-6">
                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="p-2.5 rounded-lg bg-muted/50">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{invite.companyName}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t.rich('wrong_account', {
                          invitedEmail: invite.email,
                          currentEmail: currentUserEmail ?? '',
                          strong: (chunks) => <strong>{chunks}</strong>,
                        })}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t('signout_then_login')}
                      </p>
                    </div>
                  </div>
                </Card>

                <Button size="lg" className="w-full" onClick={handleSignOutAndRetry}>
                  {t('signout_and_switch')}
                </Button>
              </div>
            ) : invite?.alreadyHasAccount ? (
              // Not signed in — email has an existing account, bounce to login.
              <div className="space-y-6">
                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="p-2.5 rounded-lg bg-muted/50">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{invite.companyName}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t('invited_to_company')}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t.rich('existing_account', {
                          email: invite.email,
                          appName: branding.appName.toLowerCase(),
                          strong: (chunks) => <strong>{chunks}</strong>,
                        })}
                      </p>
                    </div>
                  </div>
                </Card>

                <Button size="lg" className="w-full" onClick={handleAcceptExistingUser}>
                  {t('login_and_join')}
                </Button>
              </div>
            ) : invite ? (
              // Not signed in, no existing account — register.
              <div className="space-y-6">
                <Card className="p-6">
                  <div className="flex items-start gap-4">
                    <div className="p-2.5 rounded-lg bg-muted/50">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium">{invite.companyName}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {t('invited_to_company')}
                      </p>
                    </div>
                  </div>
                </Card>

                <Button size="lg" className="w-full" onClick={handleAccept}>
                  {t('create_account_and_join')}
                </Button>

                <p className="text-center text-xs text-muted-foreground">
                  {t('terms_notice')}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  )
}
