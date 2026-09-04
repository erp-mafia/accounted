'use client'

import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'

export interface WorklistBadges {
  /**
   * Rows waiting in the Transaktioner inbox: unbooked bank transactions
   * (lib/worklist countUnbookedTransactions) plus unbooked skattekonto rows
   * (countUnbookedSkattekontoRows). The badge sits on /transactions, which
   * lists both, so the number must cover both (#2180).
   */
  uncategorized: number
  /** Agent-staged operations awaiting review: same predicate as countPendingOperations. */
  pendingOperations: number
}

/**
 * Client-side nav badge counts. These used to be fetched by the dashboard
 * layout on the critical path of every server navigation; two head-count
 * queries nobody needs before first paint. Now they load (and revalidate)
 * after mount, and SWR dedupes the realtime-triggered refreshes that
 * previously stampeded during bulk operations.
 *
 * The predicates deliberately mirror lib/worklist/categories.ts so the badge
 * shows the same number as every other "att göra" surface; RLS scopes both
 * tables, and the explicit company_id filter is defense in depth.
 */
export function useWorklistBadges(companyId: string | null | undefined) {
  const { data, mutate } = useSWR<WorklistBadges>(
    companyId ? ['worklist-badges', companyId] : null,
    async ([, id]: [string, string]) => {
      const supabase = createClient()
      const [tx, skv, ops] = await Promise.all([
        supabase
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', id)
          .is('is_business', null)
          .eq('is_ignored', false),
        supabase
          .from('skattekonto_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', id)
          .eq('status', 'booked')
          .is('journal_entry_id', null)
          .eq('is_ignored', false),
        supabase
          .from('pending_operations')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', id)
          .eq('status', 'pending'),
      ])
      return {
        uncategorized: (tx.error ? 0 : (tx.count ?? 0)) + (skv.error ? 0 : (skv.count ?? 0)),
        pendingOperations: ops.error ? 0 : (ops.count ?? 0),
      }
    },
  )

  return {
    uncategorized: data?.uncategorized ?? 0,
    pendingOperations: data?.pendingOperations ?? 0,
    // SWR's bound mutate is referentially stable, so consumers can list it in
    // effect deps without re-subscribing on every render.
    refresh: mutate,
  }
}
