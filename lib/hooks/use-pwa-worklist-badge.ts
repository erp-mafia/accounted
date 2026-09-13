'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { useCapability, useCompany } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { syncAppBadge } from '@/lib/pwa/app-badge'
import { isPwaWorklistBadgeEnabled } from '@/lib/ui-state/client'
import { visibleWorklistTotal } from '@/lib/worklist/visible-total'
import type { WorklistCounts } from '@/lib/worklist/types'

async function fetchWorklistCounts(): Promise<WorklistCounts> {
  const res = await fetch('/api/worklist/counts')
  if (!res.ok) throw new Error('worklist counts failed')
  const json = (await res.json()) as { data: WorklistCounts }
  return json.data
}

/**
 * Mirrors the Att göra header on the home-screen PWA icon.
 *
 * Same /api/worklist/counts + visibleWorklistTotal path as the dashboard
 * (inbox_document hidden without AI). Expiring bank connections stay
 * dashboard-only: they are not a worklist category.
 */
export function usePwaWorklistBadge() {
  const { company } = useCompany()
  const hasAi = useCapability(CAPABILITY.ai)
  const { uiState, loaded } = useUiState()
  const companyId = company?.id ?? null
  const enabled = isPwaWorklistBadgeEnabled(uiState)

  const { data } = useSWR<WorklistCounts>(
    companyId && enabled ? ['pwa-worklist-badge', companyId] : null,
    fetchWorklistCounts,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
    },
  )

  useEffect(() => {
    if (loaded && !enabled) {
      void syncAppBadge(0)
      return
    }
    if (!companyId) {
      void syncAppBadge(0)
      return
    }
    if (!data) return
    void syncAppBadge(
      visibleWorklistTotal({
        total: data.total,
        inboxDocumentCount: data.counts.inbox_document,
        hasAi,
      }),
    )
  }, [companyId, data, enabled, hasAi, loaded])
}
