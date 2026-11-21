'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { CreateDrawer } from '@/components/ui/create-drawer'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsGroup, SettingsRowNote, SettingsSelect } from '@/components/settings/SettingsRows'
import { SettingsTopBarPortal, useSettingsTopBarSlots } from '@/components/settings/SettingsTopBar'
import { parseCompanyMembersPayload, type MembersProfileChoice } from '@/components/settings/members-payload'
import { PACKAGES } from '@/lib/modules/packages'
import { PROFILES, isProfileId, latestProfile, packagesOffIn, type ProfileId } from '@/lib/modules/profiles'
import { isInviteExpired } from '@/components/settings/invite-expiry'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatDateLong } from '@/lib/utils'
import { ArrowPathIcon, EnvelopeIcon, PlusIcon, TrashIcon } from '@/components/icons'

interface CompanyMemberItem {
  id: string
  user_id: string
  email: string
  role: string
  source: 'direct' | 'team'
  joined_at: string
  is_current_user: boolean
}

interface CompanyInvitation {
  id: string
  email: string
  role: string
  status: string
  expires_at: string
  created_at: string
}

/**
 * The shareable accept link from the latest invite or re-send response. Raw
 * tokens are never stored server-side (only their hash), so the link exists
 * exactly once: here, until the next navigation. Kept visible so a failed or
 * absent mail send (self-hosted without a mail provider, #1710) never
 * dead-ends the inviter. A lost link is renewed with the row's re-send action.
 * provisioned = GoTrue created the account and sent its own invite mail
 * (AUTH_SIGNUPS_DISABLED path), so email_sent=false is not a failure there.
 */
interface ShareableInvite {
  email: string
  url: string
  sent: boolean
  provisioned: boolean
}

export function CompanyMembersSection() {
  const t = useTranslations('settings_company')
  const locale = useLocale()
  const errorLocale = locale as ErrorLocale
  const { toast } = useToast()
  const { company } = useCompany()

  const roleLabels: Record<string, string> = {
    owner: t('members_role_owner'),
    admin: t('members_role_admin'),
    member: t('members_role_member'),
    viewer: t('members_role_viewer'),
    invoicer: t('members_role_invoicer'),
  }
  const profileName = (id: ProfileId) => {
    const profile = latestProfile(id)
    return locale === 'en' ? profile.name : profile.nameSv
  }
  // One muted sentence under the pick: what the client will not see at first.
  const profileOffNote = (id: ProfileId) => {
    const off = packagesOffIn(latestProfile(id))
    if (off.length === 0) return t('members_invite_profile_all_on')
    const names = PACKAGES.filter((p) => off.includes(p.id)).map((p) => (locale === 'en' ? p.name : p.nameSv))
    return t('members_invite_profile_off', { packages: names.join(', ') })
  }

  // null = the roster is not known: still loading, or the read failed
  // (loadError). A failed read must never render an apparently member-less
  // company: a consultant looking at an empty list re-invites people who are
  // already members. EmptyState-like rendering is reserved for a confirmed
  // empty read.
  const [members, setMembers] = useState<CompanyMemberItem[] | null>(null)
  const [invitations, setInvitations] = useState<CompanyInvitation[] | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const topBar = useSettingsTopBarSlots()
  const [inviteRole, setInviteRole] = useState<string>('viewer')
  const [isSending, setIsSending] = useState(false)
  // Why the last invite was refused, in the drawer's footer beside the primary.
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [canInvite, setCanInvite] = useState(false)
  // Multi-user seat gate: true when inviting requires the paid plan
  // (multi_user frozen). The form is swapped for the upsell line; the POST's
  // own 403 stays the real enforcement.
  const [inviteRequiresUpgrade, setInviteRequiresUpgrade] = useState(false)
  const [shareInvite, setShareInvite] = useState<ShareableInvite | null>(null)
  // The byrå's profile pick for a client company (Profiles and Suggestions):
  // null for every other company, whose invite form is unchanged. The pick
  // starts at what the server preselects (the stored profile, else the one
  // derived from the legal form, else Standard) and travels with the invite.
  const [profileChoice, setProfileChoice] = useState<MembersProfileChoice | null>(null)
  const [inviteProfile, setInviteProfile] = useState<ProfileId | null>(null)

  const fetchMembers = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/company/members')
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const body = await res.json().catch(() => null)
        const sessionGone = res.status === 401 || res.status === 403
        setMembers(null)
        setInvitations(null)
        setCanInvite(false)
        setLoadError({
          detail: sessionGone
            ? getErrorMessage(body, { statusCode: res.status, locale: errorLocale })
            : null,
        })
        return
      }
      // A 200 whose body will not parse throws into the catch below; a 200
      // without the roster lists is a failed read too. Neither may become a
      // fabricated empty member list.
      const parsed = parseCompanyMembersPayload<CompanyMemberItem, CompanyInvitation>(
        await res.json(),
      )
      if (parsed === null) {
        setMembers(null)
        setInvitations(null)
        setCanInvite(false)
        setLoadError({ detail: null })
        return
      }
      setMembers(parsed.members)
      setInvitations(parsed.invitations)
      setCanInvite(parsed.canInvite)
      setInviteRequiresUpgrade(parsed.inviteRequiresUpgrade)
      setProfileChoice(parsed.profileChoice)
      setInviteProfile(parsed.profileChoice?.preselected ?? null)
    } catch {
      setMembers(null)
      setInvitations(null)
      setCanInvite(false)
      setLoadError({ detail: null })
    }
  }, [errorLocale])

  useEffect(() => {
    void fetchMembers()
  }, [fetchMembers, reloadKey])

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return

    setIsSending(true)
    setInviteError(null)
    try {
      const res = await fetch('/api/company/members/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: inviteRole,
          ...(profileChoice && inviteProfile ? { profile_id: inviteProfile } : {}),
        }),
      })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        setInviteError(
          getErrorMessage(data, { statusCode: res.status, locale: errorLocale, fallback: t('members_invite_failed') }),
        )
        return
      }

      const payload = (
        data as {
          data?: { email_sent?: boolean; user_provisioned?: boolean; inviteUrl?: string }
        } | null
      )?.data
      const sent = payload?.email_sent !== false
      const provisioned = payload?.user_provisioned === true
      // Persist the shareable link next to the pending list: a failed or
      // skipped send leaves the invitation valid, and the toast alone is too
      // easy to miss, so the recovery path stays visible on the page.
      if (payload?.inviteUrl) {
        setShareInvite({ email, url: payload.inviteUrl, sent, provisioned })
      }
      // The title must not claim a send that never happened (self-hosted
      // without a mail provider): 'created' when nothing was mailed.
      toast({
        title: sent || provisioned ? t('members_invite_sent_title') : t('members_invite_created_title'),
        description:
          sent || provisioned
            ? t('members_invite_sent_description', { email })
            : t('members_invite_mail_not_sent'),
      })
      setInviteEmail('')
      setInviteRole('viewer')
      setInviteOpen(false)
      fetchMembers()
    } catch (err) {
      setInviteError(getErrorMessage(err, { locale: errorLocale, fallback: t('members_invite_failed') }))
    } finally {
      setIsSending(false)
    }
  }

  const handleCopyInviteLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('members_invite_link_copied_toast') })
    } catch {
      toast({ title: t('members_invite_link_copy_failed'), variant: 'destructive' })
    }
  }

  const handleRemoveMember = async (memberId: string) => {
    setRemovingId(memberId)
    try {
      const res = await fetch(`/api/company/members/${memberId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        toast({
          title: t('members_remove_failed'),
          description: getErrorMessage(data, { statusCode: res.status, locale: errorLocale, fallback: t('members_remove_failed') }),
          variant: 'destructive',
        })
        return
      }

      toast({ title: t('members_removed') })
      fetchMembers()
    } catch {
      toast({ title: t('members_remove_failed'), variant: 'destructive' })
    } finally {
      setRemovingId(null)
    }
  }

  const handleRevokeInvite = async (invite: CompanyInvitation) => {
    setRevokingId(invite.id)
    try {
      const res = await fetch(`/api/company/members/invite/${invite.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        toast({
          title: t('members_invite_revoke_failed'),
          description: getErrorMessage(data, {
            statusCode: res.status,
            locale: errorLocale,
            fallback: t('members_invite_revoke_failed'),
          }),
          variant: 'destructive',
        })
        return
      }

      // A revoked invitation's link is dead: never keep offering it.
      setShareInvite((current) => (current?.email === invite.email ? null : current))
      toast({ title: t('members_invite_revoked') })
      fetchMembers()
    } catch {
      toast({ title: t('members_invite_revoke_failed'), variant: 'destructive' })
    } finally {
      setRevokingId(null)
    }
  }

  // Re-send issues a fresh token and expiry (reviving an expired invitation)
  // and mails it again; the previous link stops working.
  const handleResendInvite = async (invite: CompanyInvitation) => {
    setResendingId(invite.id)
    try {
      const res = await fetch(`/api/company/members/invite/${invite.id}`, { method: 'POST' })
      const data = await res.json().catch(() => null)

      if (!res.ok) {
        toast({
          title: t('members_invite_resend_failed'),
          description: getErrorMessage(data, {
            statusCode: res.status,
            locale: errorLocale,
            fallback: t('members_invite_resend_failed'),
          }),
          variant: 'destructive',
        })
        return
      }

      const payload = (
        data as { data?: { email_sent?: boolean; inviteUrl?: string } } | null
      )?.data
      const sent = payload?.email_sent !== false
      if (payload?.inviteUrl) {
        setShareInvite({ email: invite.email, url: payload.inviteUrl, sent, provisioned: false })
      }
      // Same rule as the first send: never claim a mail that did not go out.
      toast({
        title: sent ? t('members_invite_resent_title') : t('members_invite_renewed_title'),
        description: sent
          ? t('members_invite_sent_description', { email: invite.email })
          : t('members_invite_mail_not_sent'),
      })
      fetchMembers()
    } catch {
      toast({ title: t('members_invite_resend_failed'), variant: 'destructive' })
    } finally {
      setResendingId(null)
    }
  }

  if (members === null || invitations === null) {
    return (
      <div>
        {/* Live region always mounted while the roster is unknown, so the
            failure is announced when it appears, not merely inserted. */}
        <div role="status" aria-live="polite" className="min-w-0 px-1">
          {loadError && (
            <AttnLine
              action={
                loadError.detail
                  ? undefined
                  : { label: t('members_load_retry'), onClick: () => setReloadKey((k) => k + 1) }
              }
            >
              {loadError.detail
                ? `${t('members_load_failed')} ${loadError.detail}`
                : t('members_load_failed')}
            </AttnLine>
          )}
        </div>
        {!loadError && (
          <div aria-busy className="space-y-3 py-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
      </div>
    )
  }

  const ownerEmail = members.find((m) => m.role === 'owner' && !m.is_current_user)?.email ?? null

  const inviteButton = (
    <Button size={topBar ? 'toolbar' : 'default'} onClick={() => setInviteOpen(true)}>
      <PlusIcon className="h-4 w-4" aria-hidden />
      {t('members_invite_button')}
    </Button>
  )

  // On the settings page the top bar already names the section; the group heading would be a second title.
  return (
    <SettingsGroup wide label={topBar ? undefined : t('members_title')} help={topBar ? undefined : t('members_invite_description')}>
      {/* Member rows: flat hairline list, no cards. */}
      {members.map((member) => (
        <div
          key={member.id}
          className="flex items-center gap-3 border-b-hairline px-1 py-3"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/60">
            <span className="text-xs font-medium text-muted-foreground">
              {member.email.charAt(0).toUpperCase()}
            </span>
          </div>
          <p className="min-w-0 flex-1 truncate text-sm">
            {member.email}
            {member.is_current_user && (
              <span className="ml-1 text-muted-foreground">{t('members_you')}</span>
            )}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {roleLabels[member.role] || member.role}
            {member.source === 'team' && <> · {t('members_team_badge')}</>}
          </span>
          {canInvite && !member.is_current_user && member.role !== 'owner' && member.source !== 'team' && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t('members_remove_aria')}
              onClick={() => handleRemoveMember(member.id)}
              loading={removingId === member.id}
            >
              {removingId !== member.id && <TrashIcon className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      ))}

      {/* Pending invitations continue the same list, visually quieter. A
          pending row past its expiry is an expired invitation (the status
          only flips when someone tries the dead link), so the date is never
          shown as a future one. */}
      {invitations.map((inv) => (
        <div
          key={inv.id}
          className="flex items-center gap-3 border-b-hairline px-1 py-3"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
            <EnvelopeIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {inv.email}
            <span className="ml-1 text-xs">
              ·{' '}
              {isInviteExpired(inv.expires_at)
                ? t('invitations_expired')
                : t('invitations_expires', { date: formatDateLong(inv.expires_at) })}
            </span>
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {roleLabels[inv.role] || inv.role}
          </span>
          {/* Re-send is inviting again, so it follows the invite form's
              seat gate: hidden while the paid-plan upsell replaces the form. */}
          {canInvite && !inviteRequiresUpgrade && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={t('members_resend_aria', { email: inv.email })}
              onClick={() => void handleResendInvite(inv)}
              disabled={revokingId === inv.id}
              loading={resendingId === inv.id}
            >
              {resendingId !== inv.id && <ArrowPathIcon className="h-3.5 w-3.5" />}
            </Button>
          )}
          {canInvite && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t('members_revoke_aria')}
              onClick={() => handleRevokeInvite(inv)}
              disabled={resendingId === inv.id}
              loading={revokingId === inv.id}
            >
              {revokingId !== inv.id && <TrashIcon className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      ))}

      {/* Shareable accept link from the latest invite: one sentence, not a
          banner. A send that failed or was skipped (no mail provider) is the
          page's single attn line; a sent or GoTrue-provisioned invite is a
          quiet muted line with the same copy action, since the link is a
          legitimate share path either way. The live region stays mounted
          (empty until a link exists) so the line is announced when it
          appears, not merely inserted; same reason as the roster block. */}
      {canInvite && (
        <div className={shareInvite ? 'px-1 pt-3' : undefined} role="status" aria-live="polite">
          {shareInvite &&
            (shareInvite.sent || shareInvite.provisioned ? (
              <p className="text-xs leading-5 text-muted-foreground">
                {t('members_invite_link_sent', { email: shareInvite.email })}{' '}
                <button
                  type="button"
                  onClick={() => void handleCopyInviteLink(shareInvite.url)}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {t('members_invite_link_copy_action')}
                </button>
              </p>
            ) : (
              <AttnLine
                action={{
                  label: t('members_invite_link_copy_action'),
                  onClick: () => void handleCopyInviteLink(shareInvite.url),
                }}
              >
                {t('members_invite_link_not_sent', { email: shareInvite.email })}
              </AttnLine>
            ))}
        </div>
      )}

      {/* Multi-user seat gate: no invite form without the paid plan. One
          muted sentence with the billing link, not a dead form. */}
      {canInvite && inviteRequiresUpgrade && (
        <p className="px-1 pt-3 text-xs leading-5 text-muted-foreground">
          {t('members_invite_upgrade')}{' '}
          <Link
            href="/settings/billing"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t('members_invite_upgrade_cta')}
          </Link>
        </p>
      )}

      {/* Bjud in is the page's one primary, in the settings top bar; outside
          the settings layout it is the list's own last row. The form opens
          in a drawer over the list (V7 creation forms): same fields, same
          submit. */}
      {canInvite && !inviteRequiresUpgrade && (
        <>
          {topBar ? (
            <SettingsTopBarPortal slot="action">{inviteButton}</SettingsTopBarPortal>
          ) : (
            <div className="px-1 pt-3">{inviteButton}</div>
          )}
          <CreateDrawer
            open={inviteOpen}
            onOpenChange={(open) => {
              setInviteOpen(open)
              if (!open) setInviteError(null)
            }}
            title={t('members_invite_drawer_title')}
            formId="company-invite-form"
            submitLabel={t('members_invite_button')}
            submitting={isSending}
            error={inviteError}
          >
            <form id="company-invite-form" onSubmit={handleInvite} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="company-invite-email">{t('members_invite_email_label')}</Label>
                <Input
                  id="company-invite-email"
                  type="email"
                  placeholder={t('members_invite_email_placeholder')}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={isSending}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-invite-role">{t('members_role_label')}</Label>
                <SettingsSelect
                  id="company-invite-role"
                  wrapperClassName="w-full"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                >
                  <option value="viewer">{t('members_role_viewer')}</option>
                  <option value="invoicer">{t('members_role_invoicer')}</option>
                  <option value="member">{t('members_role_member')}</option>
                  <option value="admin">{t('members_role_admin')}</option>
                </SettingsSelect>
                {inviteRole === 'invoicer' && <SettingsRowNote>{t('members_role_invoicer_note')}</SettingsRowNote>}
              </div>
              {/* The byrå's client: the profile is part of the invitation, picked
                  here and shown to the client when the invitation opens. */}
              {profileChoice && inviteProfile && (
                <div className="space-y-1.5">
                  <span className="flex items-center gap-2">
                    <Label htmlFor="company-invite-profile">{t('members_invite_profile_label')}</Label>
                    <HelpPopover className="shrink-0">{t('members_invite_profile_help')}</HelpPopover>
                  </span>
                  <SettingsSelect
                    id="company-invite-profile"
                    wrapperClassName="w-full"
                    value={inviteProfile}
                    onChange={(e) => {
                      if (isProfileId(e.target.value)) setInviteProfile(e.target.value)
                    }}
                    disabled={isSending}
                  >
                    {PROFILES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileName(p.id)}
                      </option>
                    ))}
                  </SettingsSelect>
                  <SettingsRowNote>{profileOffNote(inviteProfile)}</SettingsRowNote>
                </div>
              )}
            </form>
          </CreateDrawer>
        </>
      )}

      {/* A member who is not owner or admin sees no invite, remove or resend:
          one muted line says why, and who to ask when the owner is listed. */}
      {!canInvite && (
        <p className="px-1 pt-3 text-xs leading-5 text-muted-foreground">
          {ownerEmail
            ? t('members_manage_admins_only_owner', { owner: ownerEmail })
            : t('members_manage_admins_only')}
        </p>
      )}

      <p className="px-1 pt-3">
        <SettingsRowNote>
          {t('members_count', { count: members.length, companyName: company?.name ?? '' })}
        </SettingsRowNote>
      </p>
    </SettingsGroup>
  )
}
