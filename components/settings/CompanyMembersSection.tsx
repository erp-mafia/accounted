'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { parseCompanyMembersPayload } from '@/components/settings/members-payload'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatDateLong } from '@/lib/utils'
import { Loader2, Plus, Trash2, Mail } from 'lucide-react'

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
 * The shareable accept link from the latest invite response. Raw tokens are
 * never stored server-side (only their hash), so the link exists exactly
 * once: here, until the next navigation. Kept visible so a failed or absent
 * mail send (self-hosted without a mail provider, #1710) never dead-ends the
 * inviter. There is no re-send for company invites: revoke and re-invite.
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
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { company } = useCompany()

  const roleLabels: Record<string, string> = {
    owner: t('members_role_owner'),
    admin: t('members_role_admin'),
    member: t('members_role_member'),
    viewer: t('members_role_viewer'),
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
  const [inviteRole, setInviteRole] = useState<string>('viewer')
  const [isSending, setIsSending] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [canInvite, setCanInvite] = useState(false)
  // Multi-user seat gate: true when inviting requires the paid plan
  // (multi_user frozen). The form is swapped for the upsell line; the POST's
  // own 403 stays the real enforcement.
  const [inviteRequiresUpgrade, setInviteRequiresUpgrade] = useState(false)
  const [shareInvite, setShareInvite] = useState<ShareableInvite | null>(null)

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
    try {
      const res = await fetch('/api/company/members/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: inviteRole }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast({ title: data.error, variant: 'destructive' })
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
      fetchMembers()
    } catch {
      toast({ title: t('members_invite_failed'), variant: 'destructive' })
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
      const data = await res.json()

      if (!res.ok) {
        toast({ title: data.error, variant: 'destructive' })
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
      const data = await res.json()

      if (!res.ok) {
        toast({ title: data.error, variant: 'destructive' })
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
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    )
  }

  return (
    <SettingsGroup label={t('members_title')} help={t('members_invite_description')}>
      {/* Member rows: flat hairline list, no cards. */}
      {members.map((member) => (
        <div
          key={member.id}
          className="flex items-center gap-3 border-b border-border px-1 py-3"
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
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t('members_remove_aria')}
              onClick={() => handleRemoveMember(member.id)}
              disabled={removingId === member.id}
            >
              {removingId === member.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      ))}

      {/* Pending invitations continue the same list, visually quieter. */}
      {invitations.map((inv) => (
        <div
          key={inv.id}
          className="flex items-center gap-3 border-b border-border px-1 py-3"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {inv.email}
            <span className="ml-1 text-xs">
              · {t('invitations_expires', { date: formatDateLong(inv.expires_at) })}
            </span>
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {roleLabels[inv.role] || inv.role}
          </span>
          {canInvite && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={t('members_revoke_aria')}
              onClick={() => handleRevokeInvite(inv)}
              disabled={revokingId === inv.id}
            >
              {revokingId === inv.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
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
              <p className="text-[12.5px] leading-5 text-muted-foreground">
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
        <p className="px-1 pt-3 text-[12.5px] leading-5 text-muted-foreground">
          {t('members_invite_upgrade')}{' '}
          <Link
            href="/settings/billing"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t('members_invite_upgrade_cta')}
          </Link>
        </p>
      )}

      {/* Inline invite: the list's own last row instead of a separate card. */}
      {canInvite && !inviteRequiresUpgrade && (
        <form onSubmit={handleInvite} className="flex flex-col gap-3 px-1 pt-3 sm:flex-row sm:items-center">
          <label htmlFor="company-invite-email" className="sr-only">
            {t('members_invite_email_label')}
          </label>
          <SettingsInput
            id="company-invite-email"
            type="email"
            placeholder={t('members_invite_email_placeholder')}
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            disabled={isSending}
            required
            className="border-border sm:flex-1"
          />
          <SettingsSelect
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            aria-label={t('members_role_label')}
          >
            <option value="viewer">{t('members_role_viewer')}</option>
            <option value="member">{t('members_role_member')}</option>
            <option value="admin">{t('members_role_admin')}</option>
          </SettingsSelect>
          <Button type="submit" size="sm" disabled={isSending || !inviteEmail.trim()}>
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {t('members_invite_button')}
              </>
            )}
          </Button>
        </form>
      )}

      <p className="px-1 pt-3">
        <SettingsRowNote>
          {t('members_count', { count: members.length, companyName: company?.name ?? '' })}
        </SettingsRowNote>
      </p>
    </SettingsGroup>
  )
}
