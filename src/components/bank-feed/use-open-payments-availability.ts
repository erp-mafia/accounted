'use client'

import { useCallback, useEffect, useState } from 'react'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { fetchOpenPaymentsAvailability, type OpenPaymentsAvailability, type OpenPaymentsBank } from './open-payments-client'

export type OpenPaymentsStatus = 'loading' | 'available' | 'unavailable'

export interface OpenPaymentsAvailabilityState {
  status: OpenPaymentsStatus
  /** The banks, once available. */
  banks: OpenPaymentsBank[] | null
  /** Ask again (after a connection changed nothing about availability, this is rarely needed). */
  refresh: () => void
}

// One answer per company per page load, shared by every entry point: the
// Kopplingar row, the bank settings section and the onboarding step must not
// each ask the banks route.
const cache = new Map<string, Promise<OpenPaymentsAvailability>>()

function load(companyId: string, force = false): Promise<OpenPaymentsAvailability> {
  const existing = force ? undefined : cache.get(companyId)
  if (existing) return existing
  const promise = fetchOpenPaymentsAvailability().catch((): OpenPaymentsAvailability => {
    // A network failure hides the entry points for this page load; the next
    // mount asks again.
    cache.delete(companyId)
    return { available: false, banks: null }
  })
  cache.set(companyId, promise)
  return promise
}

/**
 * Whether the active company reads its bank through Open Payments, and the
 * banks to offer when it does. 'unavailable' covers the 403 for a company
 * that is not switched on as well as any failure: the Open Payments entry
 * points are hidden either way and the Enable Banking surfaces stand as before.
 */
export function useOpenPaymentsAvailability(): OpenPaymentsAvailabilityState {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const [state, setState] = useState<{ companyId: string | null; result: OpenPaymentsAvailability | null }>({ companyId: null, result: null })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    load(companyId, generation > 0).then((result) => {
      if (!cancelled) setState({ companyId, result })
    })
    return () => {
      cancelled = true
    }
  }, [companyId, generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  const current = state.companyId === companyId ? state.result : null
  if (!companyId) return { status: 'unavailable', banks: null, refresh }
  if (!current) return { status: 'loading', banks: null, refresh }
  return { status: current.available ? 'available' : 'unavailable', banks: current.banks, refresh }
}
