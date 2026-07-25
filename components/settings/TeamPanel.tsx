'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { SettingsGroup } from '@/components/settings/SettingsRows'

interface TeamMember {
  id: string
  user_id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string | null
  is_current_user: boolean
}

export function TeamPanel() {
  const t = useTranslations('settings_team_panel')
  const [isLoading, setIsLoading] = useState(true)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [teamName, setTeamName] = useState('')

  const roleLabel = (role: string) => {
    switch (role) {
      case 'owner': return t('role_owner')
      case 'admin': return t('role_admin')
      case 'member': return t('role_member')
      default: return role
    }
  }

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch('/api/team/members')
      const data = await res.json()
      if (res.ok) {
        setMembers(data.data.members)
        if (data.data.teamName) setTeamName(data.data.teamName)
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <SettingsGroup label={teamName || t('team_fallback')}>
      {/* Read-only member roster: flat hairline rows, no cards. */}
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
              <span className="ml-1 text-muted-foreground">{t('you_suffix')}</span>
            )}
          </p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {roleLabel(member.role)}
          </span>
        </div>
      ))}
    </SettingsGroup>
  )
}
