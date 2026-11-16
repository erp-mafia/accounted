'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { StandaloneHeading, StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchSessionUser, reloadTo, signOut } from '@/lib/auth/session-client'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'
import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { inviteGoneReason, type InviteGoneReason } from '@/lib/auth/invite-gone'

const branding = getBranding()

/**
 * How long the pre-auth invite cookie lives, in seconds.
 *
 * This hop has to survive an email round-trip: an invitee who clicks "create
 * account" at 17:00 confirms the signup mail the next morning, and only then
 * lands back on a surface that can redeem the token. A one-hour cookie made
 * that acceptance impossible while the invitation itself was still `pending`
 * in the database, with no way for the invitee to recover: the cookie is the
 * only copy the browser holds.
 *
 * The value is the invite TTL, `INVITE_TTL_DAYS` in lib/auth/invite-tokens.ts,
 * which is what actually bounds the token: `getInviteExpiry()` stamps
 * `company_invitations.expires_at` 7 days out at issue time and POST
 * /api/team/accept rejects anything past it with 410. `INVITE_TTL_DAYS` is a
 * module-private const in a server-only module (it imports Node's `crypto`),
 * so the number is restated here rather than imported;
 * app/invite/[token]/__tests__/invite-cookie.test.ts reads the real TTL back
 * out of `getInviteExpiry()` and fails if the two drift.
 *
 * Widening the cookie does not widen authority. Every acceptance attempt is
 * re-authorized server-side by `requireAuth()` plus an email equality check
 * against the invitation, and the `status` transition is single-use, so a
 * surviving cookie confers nothing on its own. If the invitation expires
 * before the cookie does (the invitee sat on the mail for six days), the next
 * attempt gets a 410, which `consumeInviteCookie()` classifies as `spent` and
 * clears. Never set this beyond the invite TTL: a cookie outliving the
 * server-side bound would be lifetime the server does not honour.
 */
const INVITE_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * The single construction site for the invite cookie. Three hops write it
 * (register, login, sign-out-and-retry) and each used to carry its own copy of
 * the string. They happened to still agree, but three literals is how a
 * lifetime drifts; one builder is what makes the max-age and the flags
 * provably identical across all three.
 *
 * Flags are unchanged from the original: path-scoped to the whole site so any
 * auth surface can read it, `samesite=lax` so it survives the top-level
 * navigation back from the confirmation mail without riding along on
 * cross-site subrequests, and `secure` whenever the page is on https. It is
 * deliberately not `httponly`: it is written from `document.cookie` and read
 * back by client-side auth surfaces.
 */
function buildInviteCookie(token: string, secureFlag: string): string {
  return `${INVITE_COOKIE_NAME}=${token}; path=/; max-age=${INVITE_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secureFlag}`
}

interface InviteInfo {
  type: 'company'
  companyName?: string
  email: string
  expired: boolean
  alreadyHasAccount: boolean
  /**
   * The profile the client's byrå prepared for the company (Profiles and
   * Suggestions): set only when a member of the company's byrå sent the
   * invitation and picked one. The client makes no choice here.
   */
  preparedProfile?: { id: string; name: string; name_sv: string } | null
}

/**
 * What the page says for an invitation that can no longer be accepted, per
 * reason: the heading, the next step, and whether a login link helps (it does
 * only for someone who is not signed in).
 */
const GONE_COPY = {
  used: { title: 'used_title', body: 'used_description', loginLink: true },
  used_other_account: { title: 'used_title', body: 'used_other_account_description', loginLink: false },
  revoked: { title: 'revoked_title', body: 'revoked_description', loginLink: false },
  expired: { title: 'expired_title', body: 'expired_description', loginLink: false },
} as const satisfies Record<InviteGoneReason, { title: string; body: string; loginLink: boolean }>

export default function InvitePage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('invite')
  const locale = useLocale()
  const token = params.token as string

  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  // The invitation is spent, withdrawn or expired (410 with a reason).
  const [gone, setGone] = useState<InviteGoneReason | null>(null)
  // The signed-in person already joined through this invitation: not an
  // error, they are sent into the app. Holds what they joined.
  const [joinedName, setJoinedName] = useState<string | null>(null)
  // Email of the currently signed-in user (if any). Used to short-circuit
  // the login redirect for users who are already authenticated.
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null)
  const [isJoining, setIsJoining] = useState(false)

  useEffect(() => {
    async function loadInvite() {
      try {
        // Load invite info and current session in parallel: the page needs
        // both to decide which CTA to render.
        const [inviteRes, sessionUser] = await Promise.all([
          fetch(`/api/team/accept?token=${encodeURIComponent(token)}`),
          fetchSessionUser(),
        ])

        const data = await inviteRes.json()
        if (!inviteRes.ok) {
          const reason = inviteGoneReason(data)
          if (reason) {
            setGone(reason)
            return
          }
          setError(getErrorMessage(data, { locale: locale as ErrorLocale, fallback: t('invalid_invite') }))
          return
        }

        if (data.data?.alreadyMember) {
          setJoinedName(data.data.companyName ?? '')
          return
        }

        setInvite(data.data)
        setCurrentUserEmail(sessionUser?.email ?? null)
      } catch {
        setError(t('load_failed'))
      } finally {
        setIsLoading(false)
      }
    }
    loadInvite()
  }, [token, t])

  const secureCookieFlag = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; secure' : ''

  // True when the signed-in user's email matches the invite: in that case
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
    document.cookie = buildInviteCookie(token, secureCookieFlag)
    router.push(`/register?invite=${encodeURIComponent(token)}`)
  }

  const handleAcceptExistingUser = () => {
    // Store invite token in cookie before redirecting to login
    document.cookie = buildInviteCookie(token, secureCookieFlag)
    router.push('/login')
  }

  // Already signed in as the invitee: accept directly, no login detour.
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
          description: getErrorMessage(body, { locale: locale as ErrorLocale, fallback: t('unexpected_error') }),
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
    await signOut()
    // Keep the invite cookie alive so the next login/register picks it up.
    document.cookie = buildInviteCookie(token, secureCookieFlag)
    // Full page load: nothing rendered for the previous session stays in memory.
    reloadTo(invite?.alreadyHasAccount ? '/login' : `/register?invite=${encodeURIComponent(token)}`)
  }

  // One card for every invitation that can no longer be accepted. A pending
  // invitation past its date (expired: true on a 200) reads the same as one
  // already marked expired.
  const goneCopy = gone ? GONE_COPY[gone] : invite?.expired ? GONE_COPY.expired : null

  // "Din byrå har förberett: <profil>", the same muted line in every card
  // that names the company.
  const prepared = invite?.preparedProfile
  const preparedLine = prepared ? (
    <p className="text-muted-foreground">
      {t('prepared_profile', { profile: locale === 'en' ? prepared.name : prepared.name_sv })}
    </p>
  ) : null

  if (isLoading) {
    return (
      <StandalonePage busy>
        <Skeleton className="h-7 w-56" />
        <StandaloneStack>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-11 w-full" />
        </StandaloneStack>
      </StandalonePage>
    )
  }

  // What the invitation is to: the company's name, then the sentences about it.
  const about = (name: string | null | undefined, lines: React.ReactNode) => (
    <div data-ph-mask="">
      <p className="text-[15px] font-medium leading-[22px] text-strong">{name}</p>
      <div className="mt-0.5 space-y-1 text-sm text-foreground">{lines}</div>
    </div>
  )

  return (
    // The standalone frame of the sign-in pages: what happened as the heading,
    // what to do next under it, one primary.
    <StandalonePage>
      <StandaloneHeading
        title={
          joinedName !== null
            ? t('header_already_member')
            : error
              ? t('header_invalid')
              : goneCopy
                ? t(goneCopy.title)
                : t('header_invited')
        }
      />
      <StandaloneStack>
        {error ? (
          <>
            <p className="text-sm text-foreground">
              {error} {t('contact_inviter')}
            </p>
            <Button asChild variant="outline" size="lg" className="w-full">
              <Link href="/login">{t('go_to_login')}</Link>
            </Button>
          </>
        ) : joinedName !== null ? (
          // Already joined through this invitation: straight into the app.
          <>
            {about(joinedName, <p>{t('already_member_description')}</p>)}
            {/* Full page load, as after a join: the app resolves the company context afresh. */}
            <Button size="lg" className="w-full" onClick={() => reloadTo('/')}>
              {t('already_member_open', { appName: branding.appName })}
            </Button>
          </>
        ) : goneCopy ? (
          <>
            <p className="text-sm text-foreground">{t(goneCopy.body)}</p>
            {goneCopy.loginLink && (
              <Button asChild variant="outline" size="lg" className="w-full">
                <Link href="/login">{t('go_to_login')}</Link>
              </Button>
            )}
          </>
        ) : isLoggedInAsInvitee ? (
          // Already signed in as the invitee: one-click join.
          // Prioritized over alreadyHasAccount to avoid the broken flow
          // where a false-negative from the email check would send a
          // logged-in user to /register, which middleware bounces to /.
          <>
            {about(
              invite.companyName,
              <>
                <p>{t('invited_to_company')}</p>
                <p>
                  {t.rich('logged_in_as', {
                    email: currentUserEmail ?? '',
                    strong: (chunks) => <strong className="font-medium">{chunks}</strong>,
                  })}
                </p>
                {preparedLine}
              </>,
            )}
            <Button size="lg" className="w-full" onClick={handleJoinNow} loading={isJoining}>
              {isJoining ? t('joining') : t('join_named', { companyName: invite.companyName ?? '' })}
            </Button>
          </>
        ) : isLoggedInAsOther ? (
          // Signed in as a different user: ask them to sign out first.
          <>
            {about(
              invite.companyName,
              <>
                <p>
                  {t.rich('wrong_account', {
                    invitedEmail: invite.email,
                    currentEmail: currentUserEmail ?? '',
                    strong: (chunks) => <strong className="font-medium">{chunks}</strong>,
                  })}
                </p>
                <p>{t('signout_then_login')}</p>
                {preparedLine}
              </>,
            )}
            <Button size="lg" className="w-full" onClick={handleSignOutAndRetry}>
              {t('signout_and_switch')}
            </Button>
          </>
        ) : invite?.alreadyHasAccount ? (
          // Not signed in: email has an existing account, bounce to login.
          <>
            {about(
              invite.companyName,
              <>
                <p>{t('invited_to_company')}</p>
                <p>
                  {t.rich('existing_account', {
                    email: invite.email,
                    appName: branding.appName.toLowerCase(),
                    strong: (chunks) => <strong className="font-medium">{chunks}</strong>,
                  })}
                </p>
                {preparedLine}
              </>,
            )}
            <Button size="lg" className="w-full" onClick={handleAcceptExistingUser}>
              {t('login_and_join')}
            </Button>
          </>
        ) : invite ? (
          // Not signed in, no existing account: register.
          <>
            {about(
              invite.companyName,
              <>
                <p>{t('invited_to_company')}</p>
                {preparedLine}
              </>,
            )}
            <Button size="lg" className="w-full" onClick={handleAccept}>
              {t('create_account_and_join')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('terms_notice')}</p>
          </>
        ) : null}
      </StandaloneStack>
    </StandalonePage>
  )
}
