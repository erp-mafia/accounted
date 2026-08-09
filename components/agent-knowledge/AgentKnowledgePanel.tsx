'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Brain } from 'lucide-react'
import type { LedgerContext } from '@/lib/agent-context/ledger-context'
import type { DeepLedgerContext } from '@/lib/agent-context/ledger-deep'
import type { AgentCompetence } from '@/lib/agent-context/agent-competence'
import { AgentKnowledgeView } from './AgentKnowledgeView'

interface KnowledgePayload {
  context: LedgerContext
  deep: DeepLedgerContext
  competence: AgentCompetence
  companyName: string
}

/**
 * Client wrapper for the "Vad din agent vet" view inside the assistant
 * settings hub. Fetches the ledger context from /api/agent/knowledge on mount
 * (lazy: this panel only renders when the Kunskap tab is opened, since Radix
 * unmounts inactive tabs). Fetching client-side rather than via a server prop
 * is deliberate: the settings sections mount as propless components in BOTH
 * the full-page rail and the routed settings modal, so a server fetch wouldn't
 * reach the modal.
 */
export function AgentKnowledgePanel() {
  const t = useTranslations('agentKnowledge')
  const [payload, setPayload] = useState<KnowledgePayload | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/agent/knowledge')
      .then((res) => {
        if (!res.ok) throw new Error(`knowledge fetch failed: ${res.status}`)
        return res.json()
      })
      .then((json) => {
        if (!cancelled) setPayload(json.data as KnowledgePayload)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <EmptyState
        icon={Brain}
        title={t('load_error_title')}
        description={t('load_error_description')}
      />
    )
  }

  if (!payload) {
    // Mirrors the loaded layout: graph hero, section header, two profile cards.
    return (
      <div className="space-y-8">
        <Skeleton className="h-96 w-full rounded-lg" />
        <div className="space-y-4">
          <Skeleton className="h-4 w-40" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <AgentKnowledgeView
      context={payload.context}
      deep={payload.deep}
      competence={payload.competence}
      companyName={payload.companyName}
    />
  )
}
