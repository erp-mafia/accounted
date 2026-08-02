'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Loader2, Mail, Plus, Trash2 } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsInput,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { parseTeamMembersPayload } from '@/components/settings/members-payload'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatDateLong } from '@/lib/utils'

interface TeamMember {
  id: string
  user_id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string | null
  is_current_user: boolean
}

interface TeamInvitation {
  id: string
  email: string
  role: string
  status: string
  created_at: string
  expires_at: string
}

/**
 * Team roster panel. Read-only for personal teams (exactly the pre-WL-08
 * rendering); on a byrå team where the caller may manage members
 * (canInvite = owner/admin), the same flat rows gain a role select and a
 * remove action (confirm-up-front), plus the pending-invitations list with
 * revoke and an inline invite form (WL-08 invite unfreeze, gap 2).
 */
export function TeamPanel() {
  const t = useTranslations('settings_team_panel')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  // null = the roster is not known: still loading, or the read failed
  // (loadError). A failed read must never render an apparently member-less
  // team; the empty look is reserved for a confirmed empty read.
  const [members, setMembers] = useState<TeamMember[] | null>(null)
  const [invitations, setInvitations] = useState<TeamInvitation[]>([])
  const [teamName, setTeamName] = useState('')
  const [teamId, setTeamId] = useState<string | null>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [canManage, setCanManage] = useState(false)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<string>('member')
  const [isSending, setIsSending] = useState(false)
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  // Confirm-up-front (UI convention 10): removal opens a dialog describing
  // the outcome; the DELETE only fires from its confirm button.
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null)

  const roleLabel = (role: string) => {
    switch (role) {
      case 'owner': return t('role_owner')
      case 'admin': return t('role_admin')
      case 'member': return t('role_member')
      default: return role
    }
  }

  const errorTitle = (body: unknown, fallback: string): string => {
    const message = (body as { error?: unknown } | null)?.error
    return typeof message === 'string' && message.length > 0 ? message : fallback
  }

  const fetchMembers = useCallback(async (opts?: { cancelled?: () => boolean }) => {
    const isCancelled = opts?.cancelled ?? (() => false)
    setLoadError(null)
    try {
      const res = await fetch('/api/team/members')
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const body = await res.json().catch(() => null)
        if (isCancelled()) return
        const sessionGone = res.status === 401 || res.status === 403
        setMembers(null)
        setLoadError({
          detail: sessionGone
            ? getErrorMessage(body, { statusCode: res.status, locale: errorLocale })
            : null,
        })
        return
      }
      // A 200 whose body will not parse throws into the catch below; a 200
      // without the roster list is a failed read too. Neither may become a
      // fabricated empty member list.
      const parsed = parseTeamMembersPayload<TeamMember, TeamInvitation>(await res.json())
      if (isCancelled()) return
      if (parsed === null) {
        setMembers(null)
        setLoadError({ detail: null })
        return
      }
      setMembers(parsed.members)
      setInvitations(parsed.invitations)
      setTeamId(parsed.teamId)
      setIsOwner(parsed.isOwner)
      // Management affordances follow the API's own gate: byrå owner/admin.
      setCanManage(parsed.teamKind === 'byra' && parsed.canInvite)
      if (parsed.teamName) setTeamName(parsed.teamName)
    } catch {
      if (!isCancelled()) {
        setMembers(null)
        setLoadError({ detail: null })
      }
    }
  }, [errorLocale])

  useEffect(() => {
    let cancelled = false
    void fetchMembers({ cancelled: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [fetchMembers, reloadKey])

  const handleRoleChange = async (member: TeamMember, newRole: string) => {
    setChangingRoleId(member.id)
    try {
      const res = await fetch(`/api/team/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: errorTitle(data, t('role_change_failed')), variant: 'destructive' })
        return
      }
      toast({ title: t('role_changed_toast') })
    } catch {
      toast({ title: t('role_change_failed'), variant: 'destructive' })
    } finally {
      setChangingRoleId(null)
      void fetchMembers()
    }
  }

  const handleRemove = async (member: TeamMember) => {
    try {
      const res = await fetch(`/api/team/members/${member.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: errorTitle(data, t('remove_failed')), variant: 'destructive' })
        return
      }
      toast({ title: t('removed_toast') })
    } catch {
      toast({ title: t('remove_failed'), variant: 'destructive' })
    } finally {
      void fetchMembers()
    }
  }

  const handleRevokeInvite = async (inviteId: string) => {
    setRevokingId(inviteId)
    try {
      const res = await fetch(`/api/team/invite/${inviteId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: errorTitle(data, t('revoke_failed')), variant: 'destructive' })
        return
      }
      toast({ title: t('revoked_toast') })
    } catch {
      toast({ title: t('revoke_failed'), variant: 'destructive' })
    } finally {
      setRevokingId(null)
      void fetchMembers()
    }
  }

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    const email = inviteEmail.trim().toLowerCase()
    if (!email) return

    setIsSending(true)
    try {
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: inviteRole, ...(teamId ? { teamId } : {}) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: errorTitle(data, t('invite_failed')), variant: 'destructive' })
        return
      }
      const sent = (data as { data?: { email_sent?: boolean } } | null)?.data?.email_sent
      toast({
        title: t('invite_sent_toast'),
        // A failed send leaves the invitation valid: tell the inviter the
        // mail did not go out so they share the link instead of waiting.
        description: sent === false ? t('invite_mail_not_sent') : undefined,
      })
      setInviteEmail('')
      setInviteRole('member')
      void fetchMembers()
    } catch {
      toast({ title: t('invite_failed'), variant: 'destructive' })
    } finally {
      setIsSending(false)
    }
  }

  if (members === null) {
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
                  : { label: t('load_retry'), onClick: () => setReloadKey((k) => k + 1) }
              }
            >
              {loadError.detail
                ? `${t('load_failed')} ${loadError.detail}`
                : t('load_failed')}
            </AttnLine>
          )}
        </div>
        {!loadError && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    )
  }

  return (
    <SettingsGroup label={teamName || t('team_fallback')}>
      {/* Member roster: flat hairline rows, no cards. */}
      {members.map((member) => {
        // Role select gates mirror the API: own row stays read-only (no
        // accidental self-demotion), owner rows are owner-managed, and the
        // owner option itself is owner-granted.
        const roleEditable = canManage && !member.is_current_user && (member.role !== 'owner' || isOwner)
        const removable = canManage && !member.is_current_user && (member.role !== 'owner' || isOwner)
        return (
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
                <span className="ml-1 text-muted-foreground">{t('you_suffix')}</span>
              )}
            </p>
            {roleEditable ? (
              <SettingsSelect
                value={member.role}
                onChange={(e) => void handleRoleChange(member, e.target.value)}
                disabled={changingRoleId === member.id}
                aria-label={t('role_change_aria', { email: member.email })}
                className="text-xs"
              >
                {isOwner && <option value="owner">{t('role_owner')}</option>}
                <option value="admin">{t('role_admin')}</option>
                <option value="member">{t('role_member')}</option>
              </SettingsSelect>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {roleLabel(member.role)}
              </span>
            )}
            {removable && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('remove_aria', { email: member.email })}
                onClick={() => setRemoveTarget(member)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )
      })}

      {/* Pending invitations continue the same list, visually quieter. */}
      {canManage &&
        invitations.map((inv) => {
          const expired = new Date(inv.expires_at) <= new Date()
          return (
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
                  ·{' '}
                  {expired
                    ? t('invite_expired')
                    : t('invite_expires', { date: formatDateLong(inv.expires_at) })}
                </span>
              </p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {roleLabel(inv.role)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t('revoke_aria', { email: inv.email })}
                onClick={() => void handleRevokeInvite(inv.id)}
                disabled={revokingId === inv.id}
              >
                {revokingId === inv.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          )
        })}

      {/* Inline invite: the list's own last row instead of a separate card. */}
      {canManage && (
        <form
          onSubmit={handleInvite}
          className="flex flex-col gap-3 px-1 pt-3 sm:flex-row sm:items-center"
        >
          <label htmlFor="team-invite-email" className="sr-only">
            {t('invite_email_label')}
          </label>
          <SettingsInput
            id="team-invite-email"
            type="email"
            placeholder={t('invite_email_placeholder')}
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            disabled={isSending}
            required
            className="border-border sm:flex-1"
          />
          <SettingsSelect
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            aria-label={t('invite_role_label')}
          >
            <option value="member">{t('role_member')}</option>
            <option value="admin">{t('role_admin')}</option>
          </SettingsSelect>
          <Button type="submit" size="sm" disabled={isSending || !inviteEmail.trim()}>
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                {t('invite_button')}
              </>
            )}
          </Button>
        </form>
      )}

      {/* Confirm up front: the dialog describes the outcome (loses access to
          every client company via the team) before anything is deleted. */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null)
        }}
        title={t('remove_confirm_title')}
        description={
          removeTarget
            ? t('remove_confirm_body', {
                email: removeTarget.email,
                team: teamName || t('team_fallback'),
              })
            : undefined
        }
        confirmLabel={t('remove_confirm_button')}
        destructive
        onConfirm={async () => {
          if (removeTarget) await handleRemove(removeTarget)
        }}
      />
    </SettingsGroup>
  )
}
