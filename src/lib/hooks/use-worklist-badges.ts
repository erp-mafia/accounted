'use client'

import { useCallback } from 'react'
import useSWR, { mutate as globalMutate, type SWRConfiguration } from 'swr'
import { createClient } from '@/lib/supabase/client'
import { DAILY_BATCH_TYPES_FILTER } from '@/lib/pending-operations/daily-batches'

export interface WorklistBadges {
  /**
   * Rows waiting in the Transaktioner inbox: unbooked bank transactions
   * (lib/worklist countUnbookedTransactions) plus unbooked skattekonto rows
   * (countUnbookedSkattekontoRows). The badge sits on /transactions, which
   * lists both, so the number must cover both (#2180).
   */
  uncategorized: number
  /**
   * Agent-staged operations awaiting review: same predicate as
   * countPendingOperations, so the daily batches (the collections run and
   * the reminders, rows of their own in Att göra, not agent proposals) are
   * left out.
   */
  pendingOperations: number
}

const BADGES_KEY = 'worklist-badges'

/** A return to the tab or a navigation re-reads the counts only when the last answer is this old. */
export const BADGES_STALE_MS = 15_000
/** Backstop while the tab stays visible; a hidden tab never polls. */
export const BADGES_REFRESH_MS = 60_000
/** Trailing debounce for refreshWorklistBadges: a bulk booking or bank sync emits one event per row. */
export const BADGES_BURST_MS = 400

/**
 * The badges used to be kept live by three Supabase Realtime subscriptions
 * per open tab (transactions, skattekonto_transactions, pending_operations).
 * Every open dashboard tab, visible or not, kept the Realtime WAL poller
 * running and added an RLS check per published change; that poll was the
 * single biggest database consumer. Three head-count queries when the tab
 * is looked at cost a fraction of that. The list pages that do hold a live
 * channel (Transaktioner, Granskning) call refreshWorklistBadges() from it,
 * so the badge still follows changes instantly where the user is working.
 */
export const WORKLIST_BADGES_SWR_OPTIONS = {
  // SWR's focus event covers both window focus and the tab becoming visible.
  revalidateOnFocus: true,
  focusThrottleInterval: BADGES_STALE_MS,
  revalidateOnReconnect: true,
  dedupingInterval: BADGES_STALE_MS,
  refreshInterval: BADGES_REFRESH_MS,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  // Never blank a badge while a refresh is in flight.
  keepPreviousData: true,
} satisfies SWRConfiguration

function isBadgesKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === BADGES_KEY
}

let burst: ReturnType<typeof setTimeout> | null = null

/**
 * Re-read the nav badge counts (bypasses the dedupe window) once a burst of
 * calls has gone quiet for BADGES_BURST_MS, so a bulk change of 500 rows is
 * one refresh, not 500. Called by the list pages whose own realtime channel
 * saw a change that moves a count. Client-only: it touches the SWR cache.
 */
export function refreshWorklistBadges(): void {
  if (burst) clearTimeout(burst)
  burst = setTimeout(() => {
    burst = null
    void globalMutate(isBadgesKey)
  }, BADGES_BURST_MS)
}

const lastFetchedAt = new Map<string, number>()

/**
 * Whether a navigation should re-read: the last answer is at least
 * BADGES_STALE_MS old. Never fetched means SWR's own mount fetch is on its
 * way, so a nudge then would only double it.
 */
export function badgesAreStale(lastAt: number | undefined, now: number): boolean {
  return lastAt !== undefined && now - lastAt >= BADGES_STALE_MS
}

/**
 * Client-side nav badge counts. These used to be fetched by the dashboard
 * layout on the critical path of every server navigation; two head-count
 * queries nobody needs before first paint. Now they load after mount and
 * refresh on return to the tab, on navigation (when stale), on a 60 s
 * backstop while visible, and on demand from the live list pages.
 *
 * The predicates deliberately mirror lib/worklist/categories.ts so the badge
 * shows the same number as every other "att göra" surface; RLS scopes both
 * tables, and the explicit company_id filter is defense in depth.
 */
export function useWorklistBadges(companyId: string | null | undefined) {
  const { data, mutate } = useSWR<WorklistBadges>(
    companyId ? [BADGES_KEY, companyId] : null,
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
          .eq('status', 'pending')
          .not('operation_type', 'in', DAILY_BATCH_TYPES_FILTER),
      ])
      lastFetchedAt.set(id, Date.now())
      return {
        uncategorized: (tx.error ? 0 : (tx.count ?? 0)) + (skv.error ? 0 : (skv.count ?? 0)),
        pendingOperations: ops.error ? 0 : (ops.count ?? 0),
      }
    },
    WORKLIST_BADGES_SWR_OPTIONS,
  )

  // Navigation: re-read only when the counts are older than the stale
  // window, so moving between pages does not fire three queries per click.
  const nudge = useCallback(() => {
    if (!companyId) return
    if (badgesAreStale(lastFetchedAt.get(companyId), Date.now())) void mutate()
  }, [companyId, mutate])

  return {
    uncategorized: data?.uncategorized ?? 0,
    pendingOperations: data?.pendingOperations ?? 0,
    // SWR's bound mutate is referentially stable, so consumers can list it in
    // effect deps without re-subscribing on every render.
    refresh: mutate,
    nudge,
  }
}
