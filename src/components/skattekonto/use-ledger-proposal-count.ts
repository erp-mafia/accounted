'use client'

import { useCallback, useEffect, useState } from 'react'

const ITEMS = '/api/reconciliation/accounts/skattekonto/items'

/**
 * How many skattekonto rows a verifikat already holds (the reconciliation's
 * proposals: exact twins and the ledger plan, PH 171). Null until known;
 * stays null when the account is not set up or the read fails.
 */
export function useSkattekontoLedgerProposalCount(enabled: boolean, reloadKey: unknown = 0): {
  count: number | null
  refresh: () => void
} {
  const [count, setCount] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setCount(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${ITEMS}?bucket=proposed&limit=1`)
        if (!res.ok) {
          if (!cancelled) setCount(null)
          return
        }
        const json = (await res.json()) as { data?: { total_count?: number } }
        if (!cancelled) setCount(json.data?.total_count ?? 0)
      } catch {
        if (!cancelled) setCount(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, reloadKey, tick])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { count, refresh }
}
