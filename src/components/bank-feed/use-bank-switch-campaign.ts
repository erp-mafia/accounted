'use client'

import { useCallback, useEffect, useState } from 'react'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { fetchBankSwitchProgress, type BankSwitchProgressView } from './open-payments-client'

export interface BankSwitchCampaignState {
  /** The read has answered (with an answer or a failure): what follows can act on `progress`. */
  loaded: boolean
  /** Null until the read answered, or when it failed (the surfaces then show nothing campaign-related). */
  progress: BankSwitchProgressView | null
  /** The deadline when the campaign is on and applies to the company (ISO date), else null. */
  deadline: string | null
  /** Ask again (after a switch went through). */
  refresh: () => void
}

// One answer per company per page load: the Kopplingar rows and the deep link
// handler read the same promise.
const cache = new Map<string, Promise<BankSwitchProgressView | null>>()

function load(companyId: string, force = false): Promise<BankSwitchProgressView | null> {
  const existing = force ? undefined : cache.get(companyId)
  if (existing) return existing
  const promise = fetchBankSwitchProgress().catch((): null => {
    cache.delete(companyId)
    return null
  })
  cache.set(companyId, promise)
  return promise
}

/** Tests and a finished switch: forget the cached answer so the next mount asks again. */
export function invalidateBankSwitchCampaign(companyId?: string): void {
  if (companyId) cache.delete(companyId)
  else cache.clear()
}

/**
 * The switch campaign as it applies to the active company (GET
 * /api/bank/open-payments/switch-progress): whether it is on, the deadline,
 * and which Enable Banking connections still wait. Everything about the
 * campaign in the browser hangs off this one read.
 */
export function useBankSwitchCampaign(): BankSwitchCampaignState {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const [state, setState] = useState<{ companyId: string | null; progress: BankSwitchProgressView | null; loaded: boolean }>({
    companyId: null,
    progress: null,
    loaded: false,
  })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    load(companyId, generation > 0).then((progress) => {
      if (!cancelled) setState({ companyId, progress, loaded: true })
    })
    return () => {
      cancelled = true
    }
  }, [companyId, generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  const current = state.companyId === companyId ? state : null
  const progress = current?.progress ?? null
  const deadline = progress?.campaign.on && progress.company ? progress.company.deadline : null
  // Without a company there is nothing to load: the surfaces may proceed.
  return { loaded: companyId === null || Boolean(current?.loaded), progress, deadline, refresh }
}
