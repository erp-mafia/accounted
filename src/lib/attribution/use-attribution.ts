'use client'

import { useCallback, useMemo } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { REFERENCE_SWR_OPTIONS } from '@/lib/reference-data/hooks'
import {
  attributionWordsFrom,
  formatActorAttribution,
  type AttributionOptions,
  type AttributionWords,
} from './format-actor'

interface MemberRow {
  user_id?: string
  email?: string
  full_name?: string | null
}

/** user id -> the name attribution lines use (full name, else e-mail). */
async function fetchMemberNames(): Promise<Map<string, string>> {
  const res = await fetch('/api/company/members')
  if (!res.ok) throw new Error(`Members request failed: ${res.status}`)
  const json = (await res.json()) as { data?: { members?: MemberRow[] } }
  const names = new Map<string, string>()
  for (const m of json.data?.members ?? []) {
    const name = m.full_name?.trim() || m.email?.trim()
    if (m.user_id && name) names.set(m.user_id, name)
  }
  return names
}

const NO_NAMES: ReadonlyMap<string, string> = new Map()

export interface ActorRef {
  actorType: string | null | undefined
  actorLabel?: string | null
  /** The person the agent acted for (the key owner, the sponsor, who chatted). */
  userId?: string | null
}

/**
 * Attribution lines in client UI: the active company's members' names (one
 * cached read of GET /api/company/members per company) and the words from
 * the `attribution` messages. A person who is no longer a member, or a
 * failed read, leaves the name out: the line then names the agent alone.
 */
export function useAttribution(): {
  words: AttributionWords
  personName: (userId: string | null | undefined) => string | null
  format: (actor: ActorRef, options?: AttributionOptions) => string
} {
  const t = useTranslations('attribution')
  const companyId = useCompanyOptional()?.company?.id ?? null
  const { data } = useSWR(companyId ? ['attribution-members', companyId] : null, fetchMemberNames, REFERENCE_SWR_OPTIONS)
  const names = data ?? NO_NAMES
  const words = useMemo(() => attributionWordsFrom((key, values) => t(key, values)), [t])
  const personName = useCallback((userId: string | null | undefined) => (userId ? names.get(userId) ?? null : null), [names])
  const format = useCallback(
    (actor: ActorRef, options?: AttributionOptions) =>
      formatActorAttribution(
        { actorType: actor.actorType, actorLabel: actor.actorLabel, personName: personName(actor.userId) },
        words,
        options,
      ),
    [personName, words],
  )
  return { words, personName, format }
}
