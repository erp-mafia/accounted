'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
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

export function CompanyMembersSection() {
  const t = useTranslations('settings_company')
  const { toast } = useToast()
  const { company } = useCompany()

  const roleLabels: Record<string, string> = {
    owner: t('members_role_owner'),
    admin: t('members_role_admin'),
    member: t('members_role_member'),
    viewer: t('members_role_viewer'),
  }
  const [isLoading, setIsLoading] = useState(true)
  const [members, setMembers] = useState<CompanyMemberItem[]>([])
  const [invitations, setInvitations] = useState<CompanyInvitation[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<string>('viewer')
  const [isSending, setIsSending] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [canInvite, setCanInvite] = useState(false)

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch('/api/company/members')
      const data = await res.json()
      if (res.ok) {
        setMembers(data.data.members)
        setInvitations(data.data.invitations)
        setCanInvite(data.data.canInvite)
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

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

      if (data.data.inviteUrl) {
        console.log('[DEV] Company invite URL:', data.data.inviteUrl)
      }
      toast({
        title: t('members_invite_sent_title'),
        description: data.data.inviteUrl
          ? t('members_invite_sent_dev_url')
          : t('members_invite_sent_description', { email }),
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

  const handleRevokeInvite = async (inviteId: string) => {
    setRevokingId(inviteId)
    try {
      const res = await fetch(`/api/company/members/invite/${inviteId}`, { method: 'DELETE' })
      const data = await res.json()

      if (!res.ok) {
        toast({ title: data.error, variant: 'destructive' })
        return
      }

      toast({ title: t('members_invite_revoked') })
      fetchMembers()
    } catch {
      toast({ title: t('members_invite_revoke_failed'), variant: 'destructive' })
    } finally {
      setRevokingId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
              onClick={() => handleRevokeInvite(inv.id)}
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

      {/* Inline invite: the list's own last row instead of a separate card. */}
      {canInvite && (
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
