'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { formatDateLong } from '@/lib/utils'
import { Loader2, Plus, Trash2, Mail, Clock, Users } from 'lucide-react'

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
    <div className="space-y-6">
      {/* Invite form */}
      {canInvite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('members_invite_title', { companyName: company?.name ?? '' })}</CardTitle>
            <CardDescription>
              {t('members_invite_description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <Label htmlFor="company-invite-email" className="sr-only">{t('members_invite_email_label')}</Label>
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
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="w-full sm:w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">{t('members_role_viewer')}</SelectItem>
                  <SelectItem value="member">{t('members_role_member')}</SelectItem>
                  <SelectItem value="admin">{t('members_role_admin')}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" disabled={isSending || !inviteEmail.trim()}>
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-1.5" />
                    {t('members_invite_button')}
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Members list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            {t('members_title')}
          </CardTitle>
          <CardDescription>
            {t('members_count', { count: members.length, companyName: company?.name ?? '' })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border/40">
            {members.map((member) => (
              <div key={member.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-medium text-muted-foreground">
                      {member.email.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {member.email}
                      {member.is_current_user && (
                        <span className="text-muted-foreground font-normal ml-1">{t('members_you')}</span>
                      )}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {roleLabels[member.role] || member.role}
                      </span>
                      {member.source === 'team' && (
                        <span className="text-xs text-muted-foreground">· {t('members_team_badge')}</span>
                      )}
                    </div>
                  </div>
                </div>
                {canInvite && !member.is_current_user && member.role !== 'owner' && member.source !== 'team' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
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
          </div>
        </CardContent>
      </Card>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('invitations_pending_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border/40">
              {invitations.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-muted/60 flex items-center justify-center flex-shrink-0">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{inv.email}</p>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          {t('invitations_expires', { date: formatDateLong(inv.expires_at) })}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {roleLabels[inv.role] || inv.role}
                    </span>
                    {canInvite && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
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
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
