'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import { parseTeamMembersPayload } from '@/components/settings/members-payload'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

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
  const errorLocale = useLocale() as ErrorLocale
  // null = the roster is not known: still loading, or the read failed
  // (loadError). A failed read must never render an apparently member-less
  // team; the empty look is reserved for a confirmed empty read.
  const [members, setMembers] = useState<TeamMember[] | null>(null)
  const [teamName, setTeamName] = useState('')
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const roleLabel = (role: string) => {
    switch (role) {
      case 'owner': return t('role_owner')
      case 'admin': return t('role_admin')
      case 'member': return t('role_member')
      default: return role
    }
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      try {
        const res = await fetch('/api/team/members')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const body = await res.json().catch(() => null)
          if (cancelled) return
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
        const parsed = parseTeamMembersPayload<TeamMember>(await res.json())
        if (cancelled) return
        if (parsed === null) {
          setMembers(null)
          setLoadError({ detail: null })
          return
        }
        setMembers(parsed.members)
        if (parsed.teamName) setTeamName(parsed.teamName)
      } catch {
        if (!cancelled) {
          setMembers(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey, errorLocale])

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
    <SettingsGroup label={<span data-ph-mask="">{teamName || t('team_fallback')}</span>}>
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
