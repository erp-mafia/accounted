'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Loader2, Users } from 'lucide-react'

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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            {teamName || t('team_fallback')}
          </CardTitle>
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
                        <span className="text-muted-foreground font-normal ml-1">{t('you_suffix')}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {roleLabel(member.role)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
